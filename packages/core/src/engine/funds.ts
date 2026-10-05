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
import { createWalletClient, getAddress, http, parseEther } from 'viem';
import { chainConfig, explorerTxUrl } from '../config/chains.js';
import { confirmEvmTransaction } from '../evm/executor.js';
import { viemChain } from '../evm/clients.js';
import { componentLogger } from '../obs/logger.js';
import { NoSignerError, evmSigner, solanaSigner } from '../security/signer.js';
import { solanaPool } from '../solana/connection.js';
import { confirmSolanaTransaction, SOL_FEE_BUFFER_LAMPORTS } from '../solana/executor.js';
import { readOnChainBalance, tradingWalletAddress } from './portfolio.js';

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

/** Raw units reserved in the SAVINGS bucket for the bot wallet (0 when unset). */
export async function getSavingsRaw(chain: Chain): Promise<bigint> {
  const address = tradingWalletAddress(chain);
  if (!address) return 0n;
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

export async function getSavingsQuote(chain: Chain): Promise<number> {
  const config = chainConfig(chain);
  const raw = await getSavingsRaw(chain);
  return Number(raw) / 10 ** config.nativeDecimals;
}

/**
 * Trading available after subtracting the SAVINGS reservation and fee buffer.
 * Never invents balance — starts from a live RPC read.
 */
export async function getTradingAvailableQuote(chain: Chain): Promise<{
  onChainQuote: number;
  savingsQuote: number;
  availableQuote: number;
  address: string | null;
  configured: boolean;
}> {
  const address = tradingWalletAddress(chain);
  if (!address) {
    return {
      onChainQuote: 0,
      savingsQuote: 0,
      availableQuote: 0,
      address: null,
      configured: false,
    };
  }
  const [balance, savingsQuote] = await Promise.all([
    readOnChainBalance(chain),
    getSavingsQuote(chain),
  ]);
  const availableQuote = Math.max(0, balance.availableQuote - savingsQuote);
  return {
    onChainQuote: balance.totalQuote,
    savingsQuote,
    availableQuote,
    address,
    configured: true,
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
}): Promise<{
  savingsQuote: number;
  availableQuote: number;
  onChainQuote: number;
  transferId: string;
}> {
  if (!(input.amountQuote > 0) || !Number.isFinite(input.amountQuote)) {
    throw new Error('Amount must be a positive number.');
  }
  const address = tradingWalletAddress(input.chain);
  if (!address) {
    throw new NoSignerError(chainConfig(input.chain).kind);
  }
  const config = chainConfig(input.chain);
  const scale = 10 ** config.nativeDecimals;
  const amountRaw = BigInt(Math.floor(input.amountQuote * scale));
  if (amountRaw <= 0n) throw new Error('Amount is too small.');

  const balance = await readOnChainBalance(input.chain);
  const currentSavings = await getSavingsRaw(input.chain);
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
}): Promise<{
  transactionBase64: string;
  toAddress: string;
  lamports: string;
  lastValidBlockHeight: number;
  explorerHint: string;
}> {
  const toAddress = solanaSigner.requireAddress();
  if (!(input.amountSol > 0)) throw new Error('Deposit amount must be positive.');
  const lamports = BigInt(Math.floor(input.amountSol * 1e9));
  if (lamports <= 0n) throw new Error('Deposit amount is too small.');

  const from = new PublicKey(input.fromAddress);
  const to = new PublicKey(toAddress);
  const { value: latest } = await solanaPool().call('getLatestBlockhash', (c) =>
    c.getLatestBlockhash('confirmed'),
  );

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

/** EVM deposit intent: user wallet sends native value to the bot address. */
export function buildEvmDepositIntent(input: {
  chain: Chain;
  amountNative: number;
}): {
  to: `0x${string}`;
  valueWei: string;
  chainId: number;
  nativeSymbol: string;
} {
  const config = chainConfig(input.chain);
  if (config.kind !== 'evm' || config.chainId == null) {
    throw new Error('EVM deposit requires an EVM chain.');
  }
  const to = evmSigner.requireAddress();
  if (!(input.amountNative > 0)) throw new Error('Deposit amount must be positive.');
  const valueWei = parseEther(String(input.amountNative)).toString();
  return {
    to,
    valueWei,
    chainId: config.chainId,
    nativeSymbol: config.nativeSymbol,
  };
}

/** Broadcast a user-signed Solana deposit and confirm on-chain. */
export async function broadcastSolanaDeposit(input: {
  signedTransactionBase64: string;
  lastValidBlockHeight: number;
  fromAddress: string;
  lamports: string;
}): Promise<{
  txHash: string;
  explorerUrl: string;
  status: TxStatus;
  executed: boolean;
  error: string | null;
}> {
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(input.signedTransactionBase64, 'base64'));
  } catch {
    throw new Error('signedTransaction is not a valid base64 VersionedTransaction.');
  }

  const send = await solanaPool().call('sendRawTransaction', (client) =>
    client.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: 'confirmed',
    }),
  );
  const signature = send.value;
  const confirmation = await confirmSolanaTransaction(signature, input.lastValidBlockHeight, 60_000);

  await prisma.transfer.create({
    data: {
      chain: Chain.SOLANA,
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

  const botAddress = tradingWalletAddress(input.chain);
  if (!botAddress) throw new NoSignerError(config.kind);

  const funds = await getTradingAvailableQuote(input.chain);
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
    const { value: latest } = await solanaPool().call('getLatestBlockhash', (c) =>
      c.getLatestBlockhash('confirmed'),
    );
    const message = new TransactionMessage({
      payerKey: new PublicKey(botAddress),
      recentBlockhash: latest.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: new PublicKey(botAddress),
          toPubkey: to,
          lamports: amountRaw,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    solanaSigner.sign(tx);
    const send = await solanaPool().call('sendRawTransaction', (client) =>
      client.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 0,
        preflightCommitment: 'confirmed',
      }),
    );
    txHash = send.value;
    const confirmation = await confirmSolanaTransaction(txHash, latest.lastValidBlockHeight, 60_000);
    status = confirmation.status;
    error = confirmation.error;
    confirmedAt = confirmation.status === TxStatus.CONFIRMED ? confirmation.confirmedAt : null;
  } else {
    const account = evmSigner.requireAccount();
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
      const current = await getSavingsRaw(input.chain);
      const next = current > amountRaw ? current - amountRaw : 0n;
      await writeSavingsRaw(input.chain, botAddress, next);
    }
  }

  await prisma.transfer.create({
    data: {
      chain: input.chain,
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

  const after = await getTradingAvailableQuote(input.chain);
  return {
    txHash,
    explorerUrl: explorerTxUrl(input.chain, txHash),
    status,
    executed: status === TxStatus.CONFIRMED,
    savingsQuote: after.savingsQuote,
    availableQuote: after.availableQuote,
  };
}
