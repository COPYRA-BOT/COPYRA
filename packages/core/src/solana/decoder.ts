import { Chain, TxClassification } from '@copyra/db';
import type { ParsedTransactionWithMeta, TokenBalance } from '@solana/web3.js';
import { componentLogger } from '../obs/logger.js';
import type { DecodedLeg, DecodedTransaction } from '../engine/types.js';
import {
  SOLANA_DEX_PROGRAMS,
  SOLANA_NON_TRADE_PROGRAMS,
  SOLANA_QUOTE_ASSETS,
  WRAPPED_SOL_MINT_STR,
} from './connection.js';

const log = componentLogger('solana-decoder');

/**
 * Solana transaction decoder.
 *
 * Classification is derived from **balance deltas belonging to the monitored
 * wallet**, not from instruction-name heuristics. Reading what actually moved
 * is the only reliable signal on Solana, where a single transaction can route
 * through several programs, use inner instructions, and wrap/unwrap SOL along
 * the way. Program ids are used to *attribute* the venue and to recognise
 * definitively non-trading activity (staking, bridging), never as the primary
 * evidence that a trade happened.
 *
 * Spec §3 requires that a classification is never an assumption when reliable
 * on-chain information exists. Hence: deltas first, programs second, and an
 * explicit `classificationBasis` string recorded for every decision.
 */

export interface MintDelta {
  mint: string;
  /** Positive = wallet received, negative = wallet spent. Base units. */
  deltaRaw: bigint;
  decimals: number;
}

function parseTokenBalances(
  balances: readonly TokenBalance[] | null | undefined,
  owner: string,
): Map<string, { amount: bigint; decimals: number }> {
  const out = new Map<string, { amount: bigint; decimals: number }>();
  for (const balance of balances ?? []) {
    if (balance.owner !== owner) continue;
    const existing = out.get(balance.mint);
    const amount = BigInt(balance.uiTokenAmount.amount);
    out.set(balance.mint, {
      amount: (existing?.amount ?? 0n) + amount,
      decimals: balance.uiTokenAmount.decimals,
    });
  }
  return out;
}

/**
 * Net SPL-token movement for the monitored wallet, plus native SOL.
 *
 * Native SOL is adjusted for the transaction fee when the wallet is the fee
 * payer: otherwise every transaction looks like a tiny SOL spend and a
 * fee-only transaction would be misread as a trade.
 */
export function computeBalanceDeltas(
  tx: ParsedTransactionWithMeta,
  traderAddress: string,
): MintDelta[] {
  const deltas: MintDelta[] = [];
  const meta = tx.meta;
  if (!meta) return deltas;

  const pre = parseTokenBalances(meta.preTokenBalances, traderAddress);
  const post = parseTokenBalances(meta.postTokenBalances, traderAddress);

  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(mint);
    const after = post.get(mint);
    const delta = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    if (delta === 0n) continue;
    deltas.push({
      mint,
      deltaRaw: delta,
      decimals: after?.decimals ?? before?.decimals ?? 0,
    });
  }

  // Native SOL, from the account-key list.
  const keys = tx.transaction.message.accountKeys;
  const index = keys.findIndex((k) => k.pubkey.toBase58() === traderAddress);
  if (index >= 0) {
    const before = meta.preBalances[index];
    const after = meta.postBalances[index];
    if (before !== undefined && after !== undefined) {
      let delta = BigInt(after) - BigInt(before);
      const isFeePayer = index === 0;
      if (isFeePayer) delta += BigInt(meta.fee);

      if (delta !== 0n) {
        const existing = deltas.find((d) => d.mint === WRAPPED_SOL_MINT_STR);
        if (existing) {
          // Wrapped-SOL movement and native movement are the same economic
          // asset; combine so a wrap-then-swap reads as one spend.
          existing.deltaRaw += delta;
          if (existing.deltaRaw === 0n) {
            deltas.splice(deltas.indexOf(existing), 1);
          }
        } else {
          deltas.push({ mint: WRAPPED_SOL_MINT_STR, deltaRaw: delta, decimals: 9 });
        }
      }
    }
  }

  return deltas;
}

/** Every program id touched, including inner instructions. */
export function collectProgramIds(tx: ParsedTransactionWithMeta): string[] {
  const ids = new Set<string>();
  for (const instruction of tx.transaction.message.instructions) {
    ids.add(instruction.programId.toBase58());
  }
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const instruction of inner.instructions) {
      ids.add(instruction.programId.toBase58());
    }
  }
  return [...ids];
}

function identifyVenue(programIds: string[]): string | null {
  for (const id of programIds) {
    const venue = SOLANA_DEX_PROGRAMS[id];
    if (venue) return venue;
  }
  return null;
}

function identifyNonTrade(programIds: string[]): string | null {
  for (const id of programIds) {
    const kind = SOLANA_NON_TRADE_PROGRAMS[id];
    if (kind) return kind;
  }
  return null;
}

function leg(delta: MintDelta): DecodedLeg {
  return {
    address: delta.mint,
    symbol: null,
    decimals: delta.decimals,
    amountRaw: (delta.deltaRaw < 0n ? -delta.deltaRaw : delta.deltaRaw).toString(),
  };
}

function absDelta(d: MintDelta): bigint {
  return d.deltaRaw < 0n ? -d.deltaRaw : d.deltaRaw;
}

function largestLeg(deltas: MintDelta[]): MintDelta | null {
  if (deltas.length === 0) return null;
  let best = deltas[0] as MintDelta;
  for (const d of deltas) {
    if (absDelta(d) > absDelta(best)) best = d;
  }
  return best;
}

function sumAbs(deltas: MintDelta[]): bigint {
  return deltas.reduce((sum, d) => sum + absDelta(d), 0n);
}

/**
 * Dust threshold for native SOL, in lamports (0.000001 SOL).
 *
 * Rent-exempt account creation and ATA initialisation move small amounts of SOL
 * on almost every transaction. Counting those as a "spend" would classify an
 * airdrop claim as a buy, so movements at or below this are ignored when
 * deciding direction.
 */
const SOL_DUST_LAMPORTS = 1_000n;

export function isSolanaQuoteAsset(mint: string): boolean {
  return SOLANA_QUOTE_ASSETS.has(mint);
}

export interface DecodeInput {
  tx: ParsedTransactionWithMeta;
  signature: string;
  traderAddress: string;
  /** When the monitor first saw the transaction, for latency measurement. */
  observedAt?: Date;
}

export function decodeSolanaTransaction(input: DecodeInput): DecodedTransaction {
  const { tx, signature, traderAddress } = input;
  const meta = tx.meta;

  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
  const blockNumber = tx.slot ? BigInt(tx.slot) : null;
  const programIds = collectProgramIds(tx);
  const venue = identifyVenue(programIds);
  const nonTradeKind = identifyNonTrade(programIds);

  const base = {
    chain: Chain.SOLANA,
    txHash: signature,
    traderAddress,
    blockNumber,
    blockTime,
    venue,
    feeRaw: meta ? String(meta.fee) : null,
    raw: {
      programIds,
      slot: tx.slot,
      err: meta?.err ?? null,
      logMessageCount: meta?.logMessages?.length ?? 0,
    } as Record<string, unknown>,
  };

  // A failed transaction moved no value. Record it, never trade on it.
  if (meta?.err) {
    return {
      ...base,
      classification: TxClassification.UNKNOWN,
      tokenIn: null,
      tokenOut: null,
      classificationBasis: `Transaction failed on-chain (${JSON.stringify(meta.err)}); no value moved.`,
    };
  }

  const deltas = computeBalanceDeltas(tx, traderAddress);

  const significant = deltas.filter((d) => {
    if (d.mint === WRAPPED_SOL_MINT_STR) {
      const magnitude = d.deltaRaw < 0n ? -d.deltaRaw : d.deltaRaw;
      return magnitude > SOL_DUST_LAMPORTS;
    }
    return d.deltaRaw !== 0n;
  });

  const received = significant.filter((d) => d.deltaRaw > 0n);
  const spent = significant.filter((d) => d.deltaRaw < 0n);

  base.raw.deltas = significant.map((d) => ({
    mint: d.mint,
    delta: d.deltaRaw.toString(),
    decimals: d.decimals,
  }));

  if (significant.length === 0) {
    return {
      ...base,
      classification: nonTradeKind ? mapNonTrade(nonTradeKind) : TxClassification.UNKNOWN,
      tokenIn: null,
      tokenOut: null,
      classificationBasis: nonTradeKind
        ? `No balance change for the wallet; touched a ${nonTradeKind} program.`
        : 'No net balance change for the monitored wallet (fee-only or unrelated transaction).',
    };
  }

  // Definitively non-trading programs win over delta shape: a stake withdrawal
  // also looks like "received SOL", and must not read as a sell.
  if (nonTradeKind && !venue) {
    return {
      ...base,
      classification: mapNonTrade(nonTradeKind),
      tokenIn: spent[0] ? leg(spent[0]) : null,
      tokenOut: received[0] ? leg(received[0]) : null,
      classificationBasis: `Interacted with a ${nonTradeKind} program and no known DEX program.`,
    };
  }

  // Net quote flow handles Pump.fun / Jupiter multi-leg shapes (wrap + tip +
  // token + leftover WSOL) that used to fall through as UNKNOWN / no token leg.
  const quoteSpent = spent.filter((d) => isSolanaQuoteAsset(d.mint));
  const quoteReceived = received.filter((d) => isSolanaQuoteAsset(d.mint));
  const tokenSpent = spent.filter((d) => !isSolanaQuoteAsset(d.mint));
  const tokenReceived = received.filter((d) => !isSolanaQuoteAsset(d.mint));
  const netQuoteOut = sumAbs(quoteSpent) - sumAbs(quoteReceived);
  const netQuoteIn = sumAbs(quoteReceived) - sumAbs(quoteSpent);

  // BUY: net quote spent + at least one non-quote token received.
  if (tokenReceived.length >= 1 && netQuoteOut > SOL_DUST_LAMPORTS) {
    const outLeg = largestLeg(tokenReceived) as MintDelta;
    const inLeg =
      largestLeg(quoteSpent) ??
      ({
        mint: WRAPPED_SOL_MINT_STR,
        deltaRaw: -netQuoteOut,
        decimals: 9,
      } satisfies MintDelta);
    return {
      ...base,
      classification: TxClassification.BUY,
      tokenIn: leg(inLeg),
      tokenOut: leg(outLeg),
      classificationBasis:
        `Wallet spent net ${netQuoteOut} quote units and received ${outLeg.deltaRaw} of ${outLeg.mint}` +
        (venue ? ` via ${venue}.` : ' (venue unattributed).') +
        (spent.length + received.length > 2 ? ` Multi-leg (${spent.length} out / ${received.length} in) collapsed by net quote flow.` : ''),
    };
  }

  // SELL: net quote received + at least one non-quote token spent.
  if (tokenSpent.length >= 1 && netQuoteIn > SOL_DUST_LAMPORTS) {
    const inLeg = largestLeg(tokenSpent) as MintDelta;
    const outLeg =
      largestLeg(quoteReceived) ??
      ({
        mint: WRAPPED_SOL_MINT_STR,
        deltaRaw: netQuoteIn,
        decimals: 9,
      } satisfies MintDelta);
    return {
      ...base,
      classification: TxClassification.SELL,
      tokenIn: leg(inLeg),
      tokenOut: leg(outLeg),
      classificationBasis:
        `Wallet sold ${inLeg.mint} for net ${netQuoteIn} quote units` +
        (venue ? ` via ${venue}.` : '.') +
        (spent.length + received.length > 2 ? ` Multi-leg collapsed by net quote flow.` : ''),
    };
  }

  // --- swap shapes: exactly one leg in each direction ----------------------
  if (received.length === 1 && spent.length === 1) {
    const receivedLeg = received[0] as MintDelta;
    const spentLeg = spent[0] as MintDelta;
    const receivedIsQuote = isSolanaQuoteAsset(receivedLeg.mint);
    const spentIsQuote = isSolanaQuoteAsset(spentLeg.mint);

    if (receivedIsQuote && spentIsQuote) {
      return {
        ...base,
        classification: TxClassification.UNKNOWN,
        tokenIn: leg(spentLeg),
        tokenOut: leg(receivedLeg),
        classificationBasis: 'Quote-asset to quote-asset swap (e.g. SOL/USDC); not a token trade.',
      };
    }

    // token -> token. Reported as BUY so the qualifier can reject with
    // NO_QUOTE_CURRENCY_SPENT rather than a vague "not a buy".
    return {
      ...base,
      classification: TxClassification.BUY,
      tokenIn: leg(spentLeg),
      tokenOut: leg(receivedLeg),
      classificationBasis:
        `Token-to-token swap: ${spentLeg.mint} -> ${receivedLeg.mint}. No SOL/USDC/USDT was spent.`,
    };
  }

  // --- received only -------------------------------------------------------
  if (received.length >= 1 && spent.length === 0) {
    if (received.length > 1) {
      return {
        ...base,
        classification: TxClassification.LP_REMOVE,
        tokenIn: null,
        tokenOut: leg(largestLeg(received) as MintDelta),
        classificationBasis: `Received ${received.length} assets with no spend — liquidity withdrawal or multi-asset claim.`,
      };
    }
    const only = received[0] as MintDelta;
    const isClaim = programIds.some((id) => SOLANA_NON_TRADE_PROGRAMS[id] === 'merkle-distributor');
    return {
      ...base,
      classification: isClaim ? TxClassification.CLAIM : TxClassification.AIRDROP,
      tokenIn: null,
      tokenOut: leg(only),
      classificationBasis:
        `Received ${only.deltaRaw} of ${only.mint} with no corresponding spend. ` +
        `Nothing was paid, so this is ${isClaim ? 'a claim' : 'an airdrop or incoming transfer'}, not a buy.`,
    };
  }

  // --- spent only ----------------------------------------------------------
  if (spent.length >= 1 && received.length === 0) {
    if (spent.length > 1) {
      return {
        ...base,
        classification: TxClassification.LP_ADD,
        tokenIn: leg(largestLeg(spent) as MintDelta),
        tokenOut: null,
        classificationBasis: `Spent ${spent.length} assets with no receipt — liquidity deposit.`,
      };
    }
    const only = spent[0] as MintDelta;
    return {
      ...base,
      classification: TxClassification.TRANSFER_OUT,
      tokenIn: leg(only),
      tokenOut: null,
      classificationBasis: `Sent ${only.mint} out with nothing received in return.`,
    };
  }

  log.debug(
    { signature, received: received.length, spent: spent.length },
    'Multi-leg transaction not confidently classifiable',
  );
  const spendLeg = largestLeg(spent);
  const recvLeg = largestLeg(received);
  return {
    ...base,
    classification: TxClassification.UNKNOWN,
    tokenIn: spendLeg ? leg(spendLeg) : null,
    tokenOut: recvLeg ? leg(recvLeg) : null,
    classificationBasis:
      `Ambiguous shape: ${spent.length} spend leg(s), ${received.length} receive leg(s). ` +
      'Not traded on, because the direction cannot be proven from deltas alone.',
  };
}

function mapNonTrade(kind: string): TxClassification {
  switch (kind) {
    case 'stake':
    case 'stake-pool':
      return TxClassification.STAKE;
    case 'merkle-distributor':
      return TxClassification.CLAIM;
    case 'bridge':
      return TxClassification.BRIDGE;
    case 'nft-marketplace':
      return TxClassification.NFT;
    default:
      return TxClassification.UNKNOWN;
  }
}
