import { Chain, TxClassification } from '@copyra/db';
import { decodeEventLog, erc20Abi, getAddress, parseAbi, type Log, type TransactionReceipt } from 'viem';
import type { DecodedLeg, DecodedTransaction } from '../engine/types.js';
import { chainConfig } from '../config/chains.js';
import { componentLogger } from '../obs/logger.js';
import { evmQuoteAssets } from './clients.js';
import { getErc20Metadata } from './tokens.js';

const log = componentLogger('evm-decoder');

/**
 * EVM transaction decoder.
 *
 * Like the Solana decoder, classification comes from what actually moved: the
 * ERC-20 `Transfer` logs in the receipt plus the native-value delta. Router
 * calldata is not parsed, because every aggregator has its own encoding and a
 * calldata-based decoder silently breaks when a router upgrades. Transfer logs
 * are canonical and version-independent.
 *
 * `Deposit`/`Withdrawal` on the wrapped-native contract are folded into the
 * native leg, so a "swap ETH for TOKEN" that internally wraps first reads as a
 * single ETH spend rather than two unrelated movements.
 */

const WETH_ABI = parseAbi([
  'event Deposit(address indexed dst, uint256 wad)',
  'event Withdrawal(address indexed src, uint256 wad)',
]);

/** Event signatures that prove the transaction was not a simple trade. */
const LP_EVENT_TOPICS = new Set([
  // Uniswap V2 Mint(address,uint256,uint256) / Burn(address,uint256,uint256,address)
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
  // Uniswap V3 Mint / Burn
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
]);

const SWAP_EVENT_TOPICS = new Set([
  // Uniswap V2 Swap
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  // Uniswap V3 Swap
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  // Balancer / Curve TokenExchange
  '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140',
  // Aerodrome/Velodrome Swap
  '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b',
]);

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface EvmDecodeInput {
  chain: Chain;
  receipt: TransactionReceipt;
  traderAddress: string;
  /** Native value sent with the transaction, from the transaction object. */
  nativeValue: bigint;
  /** Native value received, derived from internal transfers when available. */
  nativeReceived?: bigint;
  blockTimestamp: Date | null;
  /** Router/aggregator the transaction was sent to. */
  toAddress: string | null;
}

interface TokenMovement {
  address: string;
  deltaRaw: bigint;
  decimals: number | null;
  symbol: string | null;
}

function normalise(address: string): string {
  return address.toLowerCase();
}

/** Net ERC-20 movement for the monitored wallet, from Transfer logs. */
export function computeEvmTokenDeltas(
  logs: readonly Log[],
  traderAddress: string,
): Map<string, bigint> {
  const trader = normalise(traderAddress);
  const deltas = new Map<string, bigint>();

  for (const entry of logs) {
    if (entry.topics[0] !== TRANSFER_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: entry.data,
        topics: entry.topics,
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { from, to, value } = decoded.args as { from: string; to: string; value: bigint };
      const token = normalise(entry.address);

      if (normalise(to) === trader) {
        deltas.set(token, (deltas.get(token) ?? 0n) + value);
      }
      if (normalise(from) === trader) {
        deltas.set(token, (deltas.get(token) ?? 0n) - value);
      }
    } catch {
      // Not a standard Transfer (e.g. an ERC-721 with the same topic shape).
      continue;
    }
  }

  for (const [token, delta] of [...deltas.entries()]) {
    if (delta === 0n) deltas.delete(token);
  }
  return deltas;
}

/** Wrapped-native deposit/withdrawal attributable to the wallet. */
function computeWrapDelta(logs: readonly Log[], chain: Chain, traderAddress: string): bigint {
  const wrapped = chainConfig(chain).quoteAsset.toLowerCase();
  const trader = normalise(traderAddress);
  let delta = 0n;

  for (const entry of logs) {
    if (normalise(entry.address) !== wrapped) continue;
    try {
      const decoded = decodeEventLog({ abi: WETH_ABI, data: entry.data, topics: entry.topics });
      const args = decoded.args as { dst?: string; src?: string; wad: bigint };
      if (decoded.eventName === 'Deposit' && args.dst && normalise(args.dst) === trader) {
        delta -= args.wad; // native spent to obtain wrapped
      }
      if (decoded.eventName === 'Withdrawal' && args.src && normalise(args.src) === trader) {
        delta += args.wad; // wrapped burned back into native
      }
    } catch {
      continue;
    }
  }
  return delta;
}

async function toLeg(
  chain: Chain,
  address: string,
  amountRaw: bigint,
): Promise<DecodedLeg> {
  const magnitude = amountRaw < 0n ? -amountRaw : amountRaw;
  const config = chainConfig(chain);

  if (address === 'native') {
    return {
      address: config.quoteAsset || 'native',
      symbol: config.nativeSymbol,
      decimals: config.nativeDecimals,
      amountRaw: magnitude.toString(),
    };
  }

  try {
    const metadata = await getErc20Metadata(chain, address);
    return {
      address: address.toLowerCase(),
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      amountRaw: magnitude.toString(),
    };
  } catch (error) {
    log.warn({ chain, address, err: error }, 'ERC-20 metadata unavailable while decoding');
    return {
      address: address.toLowerCase(),
      symbol: null,
      // Null, never 18. The qualifier rejects a token with unknown decimals.
      decimals: null,
      amountRaw: magnitude.toString(),
    };
  }
}

export async function decodeEvmTransaction(input: EvmDecodeInput): Promise<DecodedTransaction> {
  const { chain, receipt, traderAddress } = input;
  const quoteAssets = evmQuoteAssets(chain);
  const config = chainConfig(chain);

  const base = {
    chain,
    txHash: receipt.transactionHash,
    traderAddress,
    blockNumber: receipt.blockNumber,
    blockTime: input.blockTimestamp,
    venue: input.toAddress,
    feeRaw: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    raw: {
      to: input.toAddress,
      logCount: receipt.logs.length,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status,
    } as Record<string, unknown>,
  };

  if (receipt.status !== 'success') {
    return {
      ...base,
      classification: TxClassification.UNKNOWN,
      tokenIn: null,
      tokenOut: null,
      classificationBasis: 'Transaction reverted on-chain; no value moved.',
    };
  }

  const tokenDeltas = computeEvmTokenDeltas(receipt.logs, traderAddress);
  const wrapDelta = computeWrapDelta(receipt.logs, chain, traderAddress);

  // Native delta: value sent out, plus any unwrap received, plus wrap spent.
  let nativeDelta = -input.nativeValue + (input.nativeReceived ?? 0n) + wrapDelta;

  // A wrapped-native Transfer and a native wrap are the same asset; fold them.
  const wrappedKey = config.quoteAsset.toLowerCase();
  const wrappedTokenDelta = tokenDeltas.get(wrappedKey);
  if (wrappedTokenDelta !== undefined && wrapDelta !== 0n) {
    nativeDelta += wrappedTokenDelta;
    tokenDeltas.delete(wrappedKey);
  }

  const movements: TokenMovement[] = [];
  for (const [address, delta] of tokenDeltas) {
    movements.push({ address, deltaRaw: delta, decimals: null, symbol: null });
  }

  // Gas dust: ignore native movement smaller than a plausible trade.
  const nativeDust = 10n ** BigInt(Math.max(0, config.nativeDecimals - 6));
  if (nativeDelta !== 0n && (nativeDelta > nativeDust || nativeDelta < -nativeDust)) {
    movements.push({ address: 'native', deltaRaw: nativeDelta, decimals: config.nativeDecimals, symbol: config.nativeSymbol });
  }

  base.raw.deltas = movements.map((m) => ({ address: m.address, delta: m.deltaRaw.toString() }));

  const received = movements.filter((m) => m.deltaRaw > 0n);
  const spent = movements.filter((m) => m.deltaRaw < 0n);

  const topics = new Set(receipt.logs.map((l) => l.topics[0]).filter(Boolean) as string[]);
  const hasLpEvent = [...topics].some((t) => LP_EVENT_TOPICS.has(t));
  const hasSwapEvent = [...topics].some((t) => SWAP_EVENT_TOPICS.has(t));

  if (hasLpEvent) {
    return {
      ...base,
      classification: spent.length > received.length ? TxClassification.LP_ADD : TxClassification.LP_REMOVE,
      tokenIn: spent[0] ? await toLeg(chain, spent[0].address, spent[0].deltaRaw) : null,
      tokenOut: received[0] ? await toLeg(chain, received[0].address, received[0].deltaRaw) : null,
      classificationBasis: 'Receipt contains a pool Mint/Burn event — liquidity provision, not a trade.',
    };
  }

  // No value moved: an approval or a no-op call.
  if (movements.length === 0) {
    const isApproval = receipt.logs.some(
      (l) => l.topics[0] === '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    );
    return {
      ...base,
      classification: isApproval ? TxClassification.APPROVAL : TxClassification.UNKNOWN,
      tokenIn: null,
      tokenOut: null,
      classificationBasis: isApproval
        ? 'Only an Approval event; no value moved.'
        : 'No net balance change for the monitored wallet.',
    };
  }

  if (received.length === 1 && spent.length === 1) {
    const receivedMove = received[0] as TokenMovement;
    const spentMove = spent[0] as TokenMovement;
    const receivedKey = receivedMove.address === 'native' ? wrappedKey : receivedMove.address;
    const spentKey = spentMove.address === 'native' ? wrappedKey : spentMove.address;
    const receivedIsQuote = quoteAssets.has(receivedKey);
    const spentIsQuote = quoteAssets.has(spentKey);

    const tokenIn = await toLeg(chain, spentMove.address, spentMove.deltaRaw);
    const tokenOut = await toLeg(chain, receivedMove.address, receivedMove.deltaRaw);

    if (spentIsQuote && !receivedIsQuote) {
      return {
        ...base,
        classification: TxClassification.BUY,
        tokenIn,
        tokenOut,
        classificationBasis:
          `Wallet spent ${-spentMove.deltaRaw} of ${spentKey} (quote asset) and received ` +
          `${receivedMove.deltaRaw} of ${receivedKey}` +
          (hasSwapEvent ? ' with a DEX Swap event present.' : ' (no recognised Swap event).'),
      };
    }
    if (receivedIsQuote && !spentIsQuote) {
      return {
        ...base,
        classification: TxClassification.SELL,
        tokenIn,
        tokenOut,
        classificationBasis: `Wallet sold ${spentKey} for ${receivedKey} (quote asset).`,
      };
    }
    if (receivedIsQuote && spentIsQuote) {
      return {
        ...base,
        classification: TxClassification.UNKNOWN,
        tokenIn,
        tokenOut,
        classificationBasis: 'Quote-to-quote swap (e.g. ETH/USDC); not a token trade.',
      };
    }
    return {
      ...base,
      classification: TxClassification.BUY,
      tokenIn,
      tokenOut,
      classificationBasis: `Token-to-token swap ${spentKey} -> ${receivedKey}; no quote asset was spent.`,
    };
  }

  if (received.length >= 1 && spent.length === 0) {
    const only = received[0] as TokenMovement;
    return {
      ...base,
      classification: received.length > 1 ? TxClassification.CLAIM : TxClassification.AIRDROP,
      tokenIn: null,
      tokenOut: await toLeg(chain, only.address, only.deltaRaw),
      classificationBasis:
        `Received ${received.length} asset(s) with no spend. Nothing was paid, so this is an ` +
        'airdrop, claim or incoming transfer, not a buy.',
    };
  }

  if (spent.length >= 1 && received.length === 0) {
    const only = spent[0] as TokenMovement;
    return {
      ...base,
      classification: TxClassification.TRANSFER_OUT,
      tokenIn: await toLeg(chain, only.address, only.deltaRaw),
      tokenOut: null,
      classificationBasis: 'Assets left the wallet with nothing received in return.',
    };
  }

  return {
    ...base,
    classification: TxClassification.UNKNOWN,
    tokenIn: spent[0] ? await toLeg(chain, spent[0].address, spent[0].deltaRaw) : null,
    tokenOut: received[0] ? await toLeg(chain, received[0].address, received[0].deltaRaw) : null,
    classificationBasis:
      `Ambiguous shape: ${spent.length} spend leg(s), ${received.length} receive leg(s). ` +
      'Not traded on, because direction cannot be proven from transfer logs alone.',
  };
}

export function isEvmQuoteAsset(chain: Chain, address: string): boolean {
  const key = address === 'native' ? chainConfig(chain).quoteAsset.toLowerCase() : address.toLowerCase();
  return evmQuoteAssets(chain).has(key);
}

export { getAddress };
