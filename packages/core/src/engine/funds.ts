import {
  BalanceBucket,
  Chain,
  TxStatus,
  prisma,
} from '@copyra/db';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, parseUnits } from 'viem';
import { chainConfig, explorerTxUrl } from '../config/chains.js';
import { confirmEvmTransaction } from '../evm/executor.js';
import { viemChain } from '../evm/clients.js';
import { componentLogger } from '../obs/logger.js';
import {
  assertAddressNotSanctioned,
  assertCustodyOperationsAllowed,
  assertDepositWithinCaps,
  assertWithdrawWithinLimits,
} from '../security/custody-safety.js';
import {
  multiUserCustodyEnabled,
  signUserSolanaTransaction,
  userCustodyAddress,
  userEvmAccount,
} from '../security/user-custody.js';
import { NoSignerError, evmSigner, solanaSigner } from '../security/signer.js';
import { solanaPool } from '../solana/connection.js';
import { confirmSolanaTransaction, SOL_FEE_BUFFER_LAMPORTS } from '../solana/executor.js';
import { readOnChainBalance, readOnChainBalanceForAddress, tradingWalletAddress } from './portfolio.js';

const log = componentLogger('funds');

const NATIVE_ASSET = 'native';

function savingsAsset(chain: Chain): { address: string; symbol: string; decimals: number } {
  const config = chainConfig(chain);
  return {
    address: NATIVE_ASSET,
    symbol: config.nativeSymbol,
    decimals: config.nativeDecimals,
  };
}

export async function getSavingsRawForAddress(chain: Chain, address: string): Promise<bigint> {
  const asset = savingsAsset(chain);
  const row = await prisma.walletBalance.findUnique({
    where: {
      chain_address_bucket_assetAddress: {
        chain,
        address,
        bucket: BalanceBucket.SAVINGS,
        assetAddress: asset.address,
      },
    },
  });
  return row ? BigInt(row.amountRaw) : 0n;
}

/** Raw units reserved in the SAVINGS bucket for the bot wallet (0 when unset). */
export async function getSavingsRaw(chain: Chain): Promise<bigint> {
  const address = tradingWalletAddress(chain);
  if (!address) return 0n;
  return getSavingsRawForAddress(chain, address);
}

async function resolveFundsWallet(chain: Chain, userId?: string): Promise<string> {
  if (multiUserCustodyEnabled() && userId) {
    return userCustodyAddress(userId, chain);
  }
  const address = tradingWalletAddress(chain);
  if (!address) throw new NoSignerError(chainConfig(chain).kind);
  return address;
}

export async function getSavingsQuote(chain: Chain): Promise<number> {
  const config = chainConfig(chain);
  const raw = await getSavingsRaw(chain);
  return Number(raw) / 10 ** config.nativeDecimals;
}

/**
 * Trading available after subtracting the SAVINGS reservation and fee buffer.
 * Never invents balance — starts from a live RPC read.
 */
export async function getTradingAvailableQuote(
  chain: Chain,
  userId?: string,
): Promise<{
  onChainQuote: number;
  savingsQuote: number;
  availableQuote: number;
  address: string | null;
  configured: boolean;
  multiUser: boolean;
}> {
  let address: string | null = null;
  if (multiUserCustodyEnabled() && userId) {
    try {
      address = await userCustodyAddress(userId, chain);
    } catch {
      address = null;
    }
  } else {
    address = tradingWalletAddress(chain);
  }
  if (!address) {
    return {
      onChainQuote: 0,
      savingsQuote: 0,
      availableQuote: 0,
      address: null,
      configured: false,
      multiUser: multiUserCustodyEnabled(),
    };
  }
  let balance;
  try {
    balance = await readOnChainBalanceForAddress(chain, address);
  } catch {
    return {
      onChainQuote: 0,
      savingsQuote: 0,
      availableQuote: 0,
      address,
      configured: false,
      multiUser: multiUserCustodyEnabled(),
    };
  }
  const savingsRaw = await getSavingsRawForAddress(chain, address);
  const config = chainConfig(chain);
  const savingsQuote = Number(savingsRaw) / 10 ** config.nativeDecimals;
  const availableQuote = Math.max(0, balance.totalQuote - savingsQuote);
  return {
    onChainQuote: balance.totalQuote,
    savingsQuote,
    availableQuote,
    address,
    configured: true,
    multiUser: multiUserCustodyEnabled(),
  };
}

async function writeSavingsRaw(chain: Chain, address: string, amountRaw: bigint): Promise<void> {
  const asset = savingsAsset(chain);
  await prisma.walletBalance.upsert({
    where: {
      chain_address_bucket_assetAddress: {
        chain,
        address,
        bucket: BalanceBucket.SAVINGS,
        assetAddress: asset.address,
      },
    },
    create: {
      chain,
      address,
      bucket: BalanceBucket.SAVINGS,
      assetAddress: asset.address,
      assetSymbol: asset.symbol,
      decimals: asset.decimals,
      amountRaw: amountRaw.toString(),
      source: 'ledger',
      readAt: new Date(),
    },
    update: {
      amountRaw: amountRaw.toString(),
      source: 'ledger',
      readAt: new Date(),
    },
  });
}

/**
 * Move funds between TRADING and SAVINGS buckets.
 * Same bot wallet on-chain — this is a reservation ledger so the engine cannot
 * spend savings. Amount is checked against live RPC + current savings.
 */
export async function moveBucket(input: {
  chain: Chain;
  direction: 't2s' | 's2t';
  amountQuote: number;
  userId: string;
}): Promise<{
  savingsQuote: number;
  availableQuote: number;
  onChainQuote: number;
  transferId: string;
}> {
  if (!(input.amountQuote > 0) || !Number.isFinite(input.amountQuote)) {
    throw new Error('Amount must be a positive number.');
  }
  await assertCustodyOperationsAllowed(input.userId);
  const address = await resolveFundsWallet(input.chain, input.userId);
  const config = chainConfig(input.chain);
  const scale = 10 ** config.nativeDecimals;
  const amountRaw = BigInt(Math.floor(input.amountQuote * scale));
  if (amountRaw <= 0n) throw new Error('Amount is too small.');

  const balance = await readOnChainBalanceForAddress(input.chain, address);
  const currentSavings = await getSavingsRawForAddress(input.chain, address);
  const onChainRaw = BigInt(Math.floor(balance.totalQuote * scale));
  const feeBuffer =
    config.kind === 'solana' ? SOL_FEE_BUFFER_LAMPORTS : BigInt(Math.floor(0.002 * scale));
  const tradingSpendable = onChainRaw > feeBuffer + currentSavings ? onChainRaw - feeBuffer - currentSavings : 0n;

  let nextSavings = currentSavings;
  if (input.direction === 't2s') {
    if (amountRaw > tradingSpendable) {
      throw new Error(
        `Only ${(Number(tradingSpendable) / scale).toFixed(6)} ${config.nativeSymbol} is available in trading after reserves.`,
      );
    }
    nextSavings = currentSavings + amountRaw;
  } else {
    if (amountRaw > currentSavings) {
      throw new Error(
        `Only ${(Number(currentSavings) / scale).toFixed(6)} ${config.nativeSymbol} is in savings.`,
      );
    }
    nextSavings = currentSavings - amountRaw;
  }

  const transfer = await prisma.transfer.create({
    data: {
      chain: input.chain,
      userId: input.userId,
      fromBucket: input.direction === 't2s' ? BalanceBucket.TRADING : BalanceBucket.SAVINGS,
      toBucket: input.direction === 't2s' ? BalanceBucket.SAVINGS : BalanceBucket.TRADING,
      assetAddress: NATIVE_ASSET,
      assetSymbol: config.nativeSymbol,
      amountRaw: amountRaw.toString(),
      status: TxStatus.CONFIRMED,
      confirmedAt: new Date(),
    },
  });
  await writeSavingsRaw(input.chain, address, nextSavings);

  const availableQuote = Number(onChainRaw > feeBuffer + nextSavings ? onChainRaw - feeBuffer - nextSavings : 0n) / scale;
  log.info(
    { chain: input.chain, direction: input.direction, amountRaw: amountRaw.toString(), transferId: transfer.id },
    'Bucket move recorded',
  );
  return {
    savingsQuote: Number(nextSavings) / scale,
    availableQuote,
    onChainQuote: balance.totalQuote,
    transferId: transfer.id,
  };
}

/** Build an unsigned Solana transfer from the user wallet to the bot trading wallet. */
export async function buildSolanaDepositTransaction(input: {
  fromAddress: string;
  amountSol: number;
  userId: string;
}): Promise<{
  transactionBase64: string;
  toAddress: string;
  lamports: string;
  lastValidBlockHeight: number;
  explorerHint: string;
}> {
  await assertCustodyOperationsAllowed(input.userId);
  assertAddressNotSanctioned(input.fromAddress, Chain.SOLANA, 'Deposit source');
  await assertDepositWithinCaps({
    userId: input.userId,
    chain: Chain.SOLANA,
    amountQuote: input.amountSol,
  });
  const toAddress = await resolveFundsWallet(Chain.SOLANA, input.userId);
  if (!(input.amountSol > 0)) throw new Error('Deposit amount must be positive.');
  const lamports = BigInt(Math.floor(input.amountSol * 1e9));
  if (lamports <= 0n) throw new Error('Deposit amount is too small.');

  const from = new PublicKey(input.fromAddress);
  const to = new PublicKey(toAddress);
  // Sticky primary RPC: blockhash from Helius must not be checked later on Alchemy
  // (that cross-endpoint hop caused "Blockhash not found" in deposit preflight).
  const { client: solClient } = solanaPool().primary();
  const balance = await solClient.getBalance(from, 'confirmed');
  // Keep a small fee buffer so Phantom / wallets can pay the network fee.
  const feeBuffer = 5_000n;
  if (BigInt(balance) < lamports + feeBuffer) {
    throw new Error(
      `Not enough SOL in the connected wallet. Need ~${((Number(lamports) + Number(feeBuffer)) / 1e9).toFixed(4)} SOL including fees; wallet has ${(balance / 1e9).toFixed(4)} SOL.`,
    );
  }
  const latest = await solClient.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: latest.blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return {
    transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    toAddress,
    lamports: lamports.toString(),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    explorerHint: 'After broadcast, confirmation is read from Solana RPC — never invented.',
  };
}

/** EVM deposit intent: ERC-20 USDC `transfer` to the user's custody wallet (real on-chain). */
export async function buildEvmDepositIntent(input: {
  chain: Chain;
  amountNative: number;
  userId: string;
}): Promise<{
  kind: 'erc20';
  /** USDC contract — `eth_sendTransaction.to` */
  to: `0x${string}`;
  tokenAddress: `0x${string}`;
  /** Custody wallet receiving USDC */
  recipient: `0x${string}`;
  /** ABI-encoded transfer(recipient, amount) */
  data: `0x${string}`;
  valueWei: '0';
  amountRaw: string;
  decimals: number;
  symbol: string;
  chainId: number;
  nativeSymbol: string;
}> {
  const config = chainConfig(input.chain);
  if (config.kind !== 'evm' || config.chainId == null) {
    throw new Error('EVM deposit requires an EVM chain.');
  }
  if (!config.stableAsset) {
    throw new Error(`No USDC contract configured for ${input.chain}.`);
  }
  await assertCustodyOperationsAllowed(input.userId);
  await assertDepositWithinCaps({
    userId: input.userId,
    chain: input.chain,
    amountQuote: input.amountNative,
  });
  if (!(input.amountNative > 0)) throw new Error('Deposit amount must be positive.');

  const recipient = getAddress(await resolveFundsWallet(input.chain, input.userId));
  const tokenAddress = getAddress(config.stableAsset);
  const decimals = config.stableAssetDecimals ?? 6;
  const amountRaw = parseUnits(String(input.amountNative), decimals);
  if (amountRaw <= 0n) throw new Error('Deposit amount is too small.');

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, amountRaw],
  });

  return {
    kind: 'erc20',
    to: tokenAddress,
    tokenAddress,
    recipient,
    data,
    valueWei: '0',
    amountRaw: amountRaw.toString(),
    decimals,
    symbol: config.stableAssetSymbol ?? 'USDC',
    chainId: config.chainId,
    nativeSymbol: config.nativeSymbol,
  };
}

/** Broadcast a user-signed Solana deposit and confirm on-chain. */
async function recordCustodyDeposit(input: {
  userId: string;
  chain: Chain;
  txHash: string;
  amountRaw: string;
  status: TxStatus;
  confirmedAt: Date | null;
}): Promise<void> {
  const existing = await prisma.custodyDeposit.findUnique({
    where: { chain_txHash: { chain: input.chain, txHash: input.txHash } },
  });
  if (existing && existing.userId !== input.userId) {
    throw new Error('This transaction hash is already credited to another account.');
  }
  if (existing) return;

  await prisma.custodyDeposit.create({
    data: {
      userId: input.userId,
      chain: input.chain,
      txHash: input.txHash,
      amountRaw: input.amountRaw,
      status: input.status,
      creditedAt: input.confirmedAt,
    },
  });
}

export async function broadcastSolanaDeposit(input: {
  signedTransactionBase64: string;
  lastValidBlockHeight: number;
  fromAddress: string;
  lamports: string;
  userId: string;
}): Promise<{
  txHash: string;
  explorerUrl: string;
  status: TxStatus;
  executed: boolean;
  error: string | null;
}> {
  await assertCustodyOperationsAllowed(input.userId);
  assertAddressNotSanctioned(input.fromAddress, Chain.SOLANA, 'Deposit source');

  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(input.signedTransactionBase64, 'base64'));
  } catch {
    throw new Error('signedTransaction is not a valid base64 VersionedTransaction.');
  }

  const custodyAddress = await resolveFundsWallet(Chain.SOLANA, input.userId);
  const accountKeys = transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  if (!accountKeys.includes(custodyAddress)) {
    throw new Error('Deposit must transfer to your COPYRA custody wallet for this account.');
  }

  // Real on-chain broadcast: skip RPC preflight (wallet already reviewed the tx).
  // Stick to the primary RPC so we never re-check a Helius blockhash on Alchemy.
  const { client: solClient } = solanaPool().primary();
  const signature = await solClient.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });
  const confirmation = await confirmSolanaTransaction(signature, input.lastValidBlockHeight, 60_000);

  const prior = await prisma.custodyDeposit.findUnique({
    where: { chain_txHash: { chain: Chain.SOLANA, txHash: signature } },
  });
  if (prior && prior.userId !== input.userId) {
    throw new Error('This deposit hash is already attributed to another user.');
  }

  await recordCustodyDeposit({
    userId: input.userId,
    chain: Chain.SOLANA,
    txHash: signature,
    amountRaw: input.lamports,
    status: confirmation.status,
    confirmedAt: confirmation.status === TxStatus.CONFIRMED ? confirmation.confirmedAt : null,
  });

  await prisma.transfer.create({
    data: {
      chain: Chain.SOLANA,
      userId: input.userId,
      fromBucket: BalanceBucket.TRADING,
      toBucket: BalanceBucket.TRADING,
      assetAddress: NATIVE_ASSET,
      assetSymbol: 'SOL',
      amountRaw: input.lamports,
      status: confirmation.status,
      txHash: signature,
      explorerUrl: explorerTxUrl(Chain.SOLANA, signature),
      errorMessage: confirmation.error,
      confirmedAt: confirmation.status === TxStatus.CONFIRMED ? confirmation.confirmedAt : null,
    },
  });

  return {
    txHash: signature,
    explorerUrl: explorerTxUrl(Chain.SOLANA, signature),
    status: confirmation.status,
    executed: confirmation.status === TxStatus.CONFIRMED,
    error: confirmation.error,
  };
}

/**
 * Withdraw from savings (preferred) or trading to the connected user wallet.
 * Requires the bot signing key — COPYRA never invents a transfer.
 */
export async function withdrawToWallet(input: {
  chain: Chain;
  toAddress: string;
  amountQuote: number;
  fromBucket: 'savings' | 'trading';
  userId: string;
}): Promise<{
  txHash: string;
  explorerUrl: string;
  status: TxStatus;
  executed: boolean;
  savingsQuote: number;
  availableQuote: number;
}> {
  if (!(input.amountQuote > 0)) throw new Error('Withdraw amount must be positive.');
  const config = chainConfig(input.chain);
  const scale = 10 ** config.nativeDecimals;
  const amountRaw = BigInt(Math.floor(input.amountQuote * scale));
  if (amountRaw <= 0n) throw new Error('Withdraw amount is too small.');

  await assertWithdrawWithinLimits({
    userId: input.userId,
    chain: input.chain,
    amountQuote: input.amountQuote,
    toAddress: input.toAddress,
  });

  const walletAddress = await resolveFundsWallet(input.chain, input.userId);

  const funds = await getTradingAvailableQuote(input.chain, input.userId);
  if (input.fromBucket === 'savings') {
    if (input.amountQuote > funds.savingsQuote + 1e-12) {
      throw new Error(`Savings only holds ${funds.savingsQuote.toFixed(6)} ${config.nativeSymbol}.`);
    }
  } else if (input.amountQuote > funds.availableQuote + 1e-12) {
    throw new Error(`Trading only holds ${funds.availableQuote.toFixed(6)} ${config.nativeSymbol} available.`);
  }

  let txHash: string;
  let status: TxStatus = TxStatus.BROADCAST;
  let error: string | null = null;
  let confirmedAt: Date | null = null;

  if (config.kind === 'solana') {
    const to = new PublicKey(input.toAddress);
    const { client: solClient } = solanaPool().primary();
    const latest = await solClient.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: new PublicKey(walletAddress),
      recentBlockhash: latest.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: new PublicKey(walletAddress),
          toPubkey: to,
          lamports: amountRaw,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    if (multiUserCustodyEnabled()) {
      await signUserSolanaTransaction(input.userId, tx);
    } else {
      solanaSigner.sign(tx);
    }
    // Real on-chain withdraw — no RPC preflight hop across providers.
    txHash = await solClient.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });
    const confirmation = await confirmSolanaTransaction(txHash, latest.lastValidBlockHeight, 60_000);
    status = confirmation.status;
    error = confirmation.error;
    confirmedAt = confirmation.status === TxStatus.CONFIRMED ? confirmation.confirmedAt : null;
  } else {
    const account = multiUserCustodyEnabled()
      ? await userEvmAccount(input.userId)
      : evmSigner.requireAccount();
    const rpcUrl = config.rpcUrl;
    if (!rpcUrl) throw new Error(`No RPC URL configured for ${input.chain}`);
    const wallet = createWalletClient({
      account,
      chain: viemChain(input.chain),
      transport: http(rpcUrl, { timeout: 20_000 }),
    });
    const hash = await wallet.sendTransaction({
      to: getAddress(input.toAddress),
      value: amountRaw,
      account,
      chain: viemChain(input.chain),
    });
    txHash = hash;
    const confirmation = await confirmEvmTransaction(
      input.chain,
      hash,
      120_000,
      config.requiredConfirmations,
    );
    status = confirmation.status;
    error = confirmation.error;
    confirmedAt = confirmation.status === TxStatus.CONFIRMED ? new Date() : null;
  }

  if (status === TxStatus.CONFIRMED) {
    if (input.fromBucket === 'savings') {
      const current = await getSavingsRawForAddress(input.chain, walletAddress);
      const next = current > amountRaw ? current - amountRaw : 0n;
      await writeSavingsRaw(input.chain, walletAddress, next);
    }
  }

  await prisma.transfer.create({
    data: {
      chain: input.chain,
      userId: input.userId,
      fromBucket: input.fromBucket === 'savings' ? BalanceBucket.SAVINGS : BalanceBucket.TRADING,
      toBucket: BalanceBucket.TRADING,
      assetAddress: NATIVE_ASSET,
      assetSymbol: config.nativeSymbol,
      amountRaw: amountRaw.toString(),
      status,
      txHash,
      explorerUrl: explorerTxUrl(input.chain, txHash),
      errorMessage: error,
      confirmedAt,
    },
  });

  const after = await getTradingAvailableQuote(input.chain, input.userId);
  return {
    txHash,
    explorerUrl: explorerTxUrl(input.chain, txHash),
    status,
    executed: status === TxStatus.CONFIRMED,
    savingsQuote: after.savingsQuote,
    availableQuote: after.availableQuote,
  };
}

/** Confirm an EVM deposit the user broadcast to their custody wallet. */
export async function recordEvmCustodyDeposit(input: {
  userId: string;
  chain: Chain;
  txHash: `0x${string}`;
  amountQuote: number;
  fromAddress: string;
}): Promise<{
  txHash: string;
  explorerUrl: string;
  status: TxStatus;
  executed: boolean;
  error: string | null;
}> {
  await assertCustodyOperationsAllowed(input.userId);
  assertAddressNotSanctioned(input.fromAddress, input.chain, 'Deposit source');
  await assertDepositWithinCaps({
    userId: input.userId,
    chain: input.chain,
    amountQuote: input.amountQuote,
  });

  const config = chainConfig(input.chain);
  const confirmation = await confirmEvmTransaction(
    input.chain,
    input.txHash,
    90_000,
    config.requiredConfirmations,
  );
  const decimals = config.stableAssetDecimals ?? config.nativeDecimals;
  const assetAddress = (config.stableAsset ?? NATIVE_ASSET).toLowerCase();
  const assetSymbol = config.stableAssetSymbol ?? config.nativeSymbol;
  const amountRaw = parseUnits(String(input.amountQuote), decimals).toString();

  await recordCustodyDeposit({
    userId: input.userId,
    chain: input.chain,
    txHash: input.txHash,
    amountRaw,
    status: confirmation.status,
    confirmedAt: confirmation.status === TxStatus.CONFIRMED ? new Date() : null,
  });

  await prisma.transfer.create({
    data: {
      chain: input.chain,
      userId: input.userId,
      fromBucket: BalanceBucket.TRADING,
      toBucket: BalanceBucket.TRADING,
      assetAddress,
      assetSymbol,
      amountRaw,
      status: confirmation.status,
      txHash: input.txHash,
      explorerUrl: explorerTxUrl(input.chain, input.txHash),
      errorMessage: confirmation.error,
      confirmedAt: confirmation.status === TxStatus.CONFIRMED ? new Date() : null,
    },
  });

  return {
    txHash: input.txHash,
    explorerUrl: explorerTxUrl(input.chain, input.txHash),
    status: confirmation.status,
    executed: confirmation.status === TxStatus.CONFIRMED,
    error: confirmation.error,
  };
}

/** User-scoped ledger read — rejects cross-user wallet addresses. */
export async function assertLedgerWalletOwnedByUser(
  userId: string,
  chain: Chain,
  address: string,
): Promise<void> {
  const owned = await resolveFundsWallet(chain, userId);
  const config = chainConfig(chain);
  const a = config.kind === 'evm' ? address.toLowerCase() : address;
  const b = config.kind === 'evm' ? owned.toLowerCase() : owned;
  if (a !== b) {
    throw new Error('Ledger address does not belong to this user.');
  }
}
