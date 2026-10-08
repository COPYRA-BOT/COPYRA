import { Chain, TxStatus } from '@copyra/db';
import {
  VersionedTransaction,
  type ParsedTransactionWithMeta,
  type TransactionConfirmationStatus,
} from '@solana/web3.js';
import { explorerTxUrl } from '../config/chains.js';
import { env } from '../config/env.js';
import { TelemetryTracker } from '../engine/telemetry.js';
import { componentLogger } from '../obs/logger.js';
import { NoSignerError, solanaSigner } from '../security/signer.js';
import {
  multiUserCustodyEnabled,
  signUserSolanaTransaction,
  userCustodyAddress,
} from '../security/user-custody.js';
import { withRetry, sleep } from '../util/retry.js';
import { MAX_SUPPORTED_TX_VERSION, solanaPool, WRAPPED_SOL_MINT_STR } from './connection.js';
import { computeBalanceDeltas } from './decoder.js';
import {
  buildJupiterSwap,
  getJupiterQuote,
  type JupiterQuote,
  type QuoteResult,
} from './jupiter.js';

const log = componentLogger('solana-executor');

export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  /** Base units of the input mint. */
  amountRaw: string;
  slippageBps: number;
  maxPriceImpactPct: number;
  quoteMaxAgeMs: number;
  confirmTimeoutMs: number;
  maxAttempts: number;
  telemetry: TelemetryTracker;
  /** Correlates retries so a repeat can never double-broadcast. */
  idempotencyKey: string;
  /** When set with multi-user custody, spend/sign from that account's custody wallet. */
  userId?: string;
  /**
   * Exit / kill-switch path: veryHigh priority fees, skip preflight, shorter
   * confirm-before-retry so blockhashes do not expire mid-attempt.
   */
  urgency?: 'normal' | 'exit';
}

export interface ExecutionOutcome {
  status: TxStatus;
  txHash: string | null;
  explorerUrl: string | null;
  slot: bigint | null;
  /** What the quote predicted, in base units. */
  quotedAmountRaw: string | null;
  /** What actually arrived, read back from confirmed on-chain balance deltas. */
  actualAmountRaw: string | null;
  /** actual / quoted. < 1 means a partial or worse-than-quoted fill. */
  fillRatio: number | null;
  /** Realised slippage against the quote, in percent. */
  realizedSlippagePct: number | null;
  priceImpactPct: number | null;
  networkFeeRaw: string | null;
  blockhash: string | null;
  lastValidBlockHeight: bigint | null;
  routeProvider: string;
  routeSummary: Record<string, unknown> | null;
  attempts: number;
  attemptLog: AttemptRecord[];
  errorCode: string | null;
  errorMessage: string | null;
  confirmations: number;
  telemetry: TelemetryTracker;
}

export interface AttemptRecord {
  attempt: number;
  at: string;
  stage: string;
  outcome: 'ok' | 'error';
  detail: string;
  txHash?: string;
}

export class PriceImpactTooHighError extends Error {
  readonly code = 'PRICE_IMPACT_TOO_HIGH';
  constructor(actual: number, limit: number) {
    super(`Price impact ${actual.toFixed(4)}% exceeds the ${limit}% limit; refusing the swap.`);
    this.name = 'PriceImpactTooHighError';
  }
}

export class QuoteStaleError extends Error {
  readonly code = 'QUOTE_STALE';
  constructor(ageMs: number, limit: number) {
    super(`Quote is ${ageMs}ms old, over the ${limit}ms limit; re-quoting before execution.`);
    this.name = 'QuoteStaleError';
  }
}

/**
 * Transaction fate, established by reading chain state.
 *
 * `CONFIRMED` is only ever reached via `getSignatureStatuses` reporting a
 * confirmation status with `err === null`. A successful `sendTransaction` call
 * means the transaction was *accepted for propagation* — nothing more — so it
 * maps to `BROADCAST`, never to success.
 */
export interface ConfirmationResult {
  status: TxStatus;
  slot: bigint | null;
  confirmationStatus: TransactionConfirmationStatus | null;
  confirmations: number;
  error: string | null;
  confirmedAt: Date | null;
}

/**
 * Polls signature status until the transaction confirms, definitively fails, or
 * its blockhash expires.
 *
 * Blockhash expiry is checked against the real current block height rather than
 * a timer, because that is what the validator actually enforces. Once the
 * height passes `lastValidBlockHeight` and the signature is still unknown, the
 * transaction can never land, which is a clean, safe failure: nothing executed.
 */
export async function confirmSolanaTransaction(
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs: number,
): Promise<ConfirmationResult> {
  const deadline = Date.now() + timeoutMs;
  // Aggressive first polls — target confirm verdict under 1s on Helius/Alchemy.
  let pollIntervalMs = 50;
  let missPolls = 0;

  while (Date.now() < deadline) {
    const statusResult = await solanaPool()
      .call('getSignatureStatuses', (client) => client.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      }))
      .catch((error: unknown) => {
        log.warn({ signature, err: error }, 'Signature status poll failed; will retry');
        return null;
      });

    const status = statusResult?.value.value[0];

    if (status) {
      missPolls = 0;
      if (status.err) {
        return {
          status: TxStatus.FAILED,
          slot: BigInt(status.slot),
          confirmationStatus: status.confirmationStatus ?? null,
          confirmations: status.confirmations ?? 0,
          error: JSON.stringify(status.err),
          confirmedAt: null,
        };
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return {
          status: TxStatus.CONFIRMED,
          slot: BigInt(status.slot),
          confirmationStatus: status.confirmationStatus,
          confirmations: status.confirmations ?? 1,
          error: null,
          confirmedAt: new Date(),
        };
      }
      // 'processed' — seen by a validator but not yet confirmed. Keep waiting.
    } else {
      missPolls += 1;
      // Check expiry often so dead txs fail fast and the executor can rebuild
      // (waiting a full ~60s for natural expiry was the 32–47s sell lag).
      if (missPolls === 1 || missPolls % 2 === 0) {
        const heightResult = await solanaPool()
          .call('getBlockHeight', (client) => client.getBlockHeight())
          .catch(() => null);
        if (heightResult && heightResult.value > lastValidBlockHeight) {
          return {
            status: TxStatus.EXPIRED,
            slot: null,
            confirmationStatus: null,
            confirmations: 0,
            error:
              `Blockhash expired: block height ${heightResult.value} passed lastValidBlockHeight ` +
              `${lastValidBlockHeight} and the signature was never observed. The transaction cannot land.`,
            confirmedAt: null,
          };
        }
      }
    }

    await sleep(pollIntervalMs);
    pollIntervalMs = Math.min(400, Math.round(pollIntervalMs * 1.35));
  }

  // Timed out with no verdict. Deliberately UNKNOWN, not FAILED: the
  // transaction may still land, so the reconciliation worker must resolve it
  // against the chain before the position is trusted.
  return {
    status: TxStatus.UNKNOWN,
    slot: null,
    confirmationStatus: null,
    confirmations: 0,
    error: `No confirmation within ${timeoutMs}ms. Status is genuinely unknown and will be reconciled against the chain.`,
    confirmedAt: null,
  };
}

/**
 * Reads what the wallet actually received from a confirmed transaction.
 *
 * This is the only acceptable source for "actual amount received". The quote is
 * a prediction and the aggregator response is a promise; only the confirmed
 * transaction's balance delta is fact. Partial fills and worse-than-quoted
 * routes show up here and nowhere else.
 */
export async function readActualFill(
  signature: string,
  walletAddress: string,
  outputMint: string,
): Promise<{ actualAmountRaw: string | null; feeRaw: string | null; tx: ParsedTransactionWithMeta | null }> {
  const result = await solanaPool()
    .call('getParsedTransaction', (client) =>
      client.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        commitment: 'confirmed',
      }),
    )
    .catch((error: unknown) => {
      log.warn({ signature, err: error }, 'Could not fetch confirmed transaction for fill readback');
      return null;
    });

  const tx = result?.value ?? null;
  if (!tx) return { actualAmountRaw: null, feeRaw: null, tx: null };

  const deltas = computeBalanceDeltas(tx, walletAddress);
  const match = deltas.find((d) => d.mint === outputMint);
  const received = match && match.deltaRaw > 0n ? match.deltaRaw.toString() : null;

  return {
    actualAmountRaw: received,
    feeRaw: tx.meta ? String(tx.meta.fee) : null,
    tx,
  };
}

/**
 * Executes a real Solana swap: quote -> guard -> build -> sign -> broadcast ->
 * confirm -> read back the actual fill.
 *
 * Every stage is retried independently with its own failure semantics. A
 * broadcast that reaches the network is never retried blindly — the existing
 * signature is confirmed first, because re-broadcasting a different transaction
 * after an ambiguous send is how duplicate buys happen.
 */
export async function executeSolanaSwap(request: SwapRequest): Promise<ExecutionOutcome> {
  const { telemetry } = request;
  const attemptLog: AttemptRecord[] = [];
  const record = (
    attempt: number,
    stage: string,
    outcome: 'ok' | 'error',
    detail: string,
    txHash?: string,
  ): void => {
    attemptLog.push({ attempt, at: new Date().toISOString(), stage, outcome, detail, ...(txHash ? { txHash } : {}) });
  };

  const failure = (
    status: TxStatus,
    errorCode: string,
    errorMessage: string,
    extra: Partial<ExecutionOutcome> = {},
  ): ExecutionOutcome => ({
    status,
    txHash: null,
    explorerUrl: null,
    slot: null,
    quotedAmountRaw: null,
    actualAmountRaw: null,
    fillRatio: null,
    realizedSlippagePct: null,
    priceImpactPct: null,
    networkFeeRaw: null,
    blockhash: null,
    lastValidBlockHeight: null,
    routeProvider: 'jupiter',
    routeSummary: null,
    // Count quote/guard loops too — "0 attempt(s)" was wrong when impact refused before broadcast.
    attempts: Math.max(
      attemptLog.filter((a) => a.stage === 'broadcast').length,
      attemptLog.reduce((m, a) => Math.max(m, a.attempt), 0),
    ),
    attemptLog,
    errorCode,
    errorMessage,
    confirmations: 0,
    telemetry,
    ...extra,
  });

  const useUserCustody = Boolean(request.userId && multiUserCustodyEnabled());
  if (!useUserCustody && !solanaSigner.available) {
    record(0, 'sign', 'error', 'No Solana signing key configured');
    return failure(
      TxStatus.FAILED,
      'NO_SIGNER',
      new NoSignerError('solana').message,
    );
  }
  let walletAddress: string;
  try {
    walletAddress = useUserCustody
      ? await userCustodyAddress(request.userId as string, Chain.SOLANA)
      : solanaSigner.requireAddress();
  } catch (error) {
    record(0, 'sign', 'error', describe(error));
    return failure(TxStatus.FAILED, 'NO_SIGNER', describe(error));
  }
  log.info(
    { wallet: walletAddress, userId: request.userId ?? null, custody: useUserCustody },
    'Solana swap will spend from trading wallet',
  );

  let lastError: unknown;

  for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
    let quote: QuoteResult;
    try {
      quote = await getJupiterQuote({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amountRaw: request.amountRaw,
        slippageBps: request.slippageBps,
      });
      telemetry.mark('quoted');
      record(
        attempt,
        'quote',
        'ok',
        `out=${quote.quote.outAmount} minOut=${quote.quote.otherAmountThreshold} impact=${quote.priceImpactPct.toFixed(4)}% route=${quote.routeLabels.join('>')}`,
      );
    } catch (error) {
      lastError = error;
      record(attempt, 'quote', 'error', error instanceof Error ? error.message : String(error));
      if (attempt === request.maxAttempts) {
        return failure(TxStatus.FAILED, 'QUOTE_FAILED', describe(error));
      }
      await sleep(40 * attempt);
      continue;
    }

    const isExit = request.urgency === 'exit';
    // --- guards, before anything is signed -------------------------------
    // Exits (TP/SL) must land even when the book is thin — refuse only extreme impact.
    const impactCeiling = isExit
      ? Math.max(request.maxPriceImpactPct, 25)
      : request.maxPriceImpactPct;
    if (quote.priceImpactPct > impactCeiling) {
      const error = new PriceImpactTooHighError(quote.priceImpactPct, impactCeiling);
      record(attempt, 'guard', 'error', error.message);
      return failure(TxStatus.FAILED, error.code, error.message, {
        priceImpactPct: quote.priceImpactPct,
        quotedAmountRaw: quote.quote.outAmount,
      });
    }

    const quoteAgeMs = Date.now() - quote.receivedAt.getTime();
    if (quoteAgeMs > request.quoteMaxAgeMs) {
      record(attempt, 'guard', 'error', new QuoteStaleError(quoteAgeMs, request.quoteMaxAgeMs).message);
      continue; // re-quote on the next loop rather than trading on stale data
    }

    // --- build ------------------------------------------------------------
    let built: Awaited<ReturnType<typeof buildJupiterSwap>>;
    try {
      built = await buildJupiterSwap({
        quote: quote.quote,
        userPublicKey: walletAddress,
        wrapAndUnwrapSol: true,
        computeUnitLimit: env.SOLANA_COMPUTE_UNIT_LIMIT,
        // Exits need to land in the next few slots — use max priority.
        priorityFeeMicroLamports: isExit
          ? Math.max(env.SOLANA_MAX_PRIORITY_FEE_MICROLAMPORTS, 2_000_000)
          : undefined,
        priorityLevel: isExit ? 'veryHigh' : 'high',
      });
      telemetry.mark('built');
      record(attempt, 'build', 'ok', `lastValidBlockHeight=${built.lastValidBlockHeight}`);
    } catch (error) {
      lastError = error;
      record(attempt, 'build', 'error', describe(error));
      if (attempt === request.maxAttempts) {
        return failure(TxStatus.FAILED, 'BUILD_FAILED', describe(error), {
          quotedAmountRaw: quote.quote.outAmount,
          priceImpactPct: quote.priceImpactPct,
        });
      }
      continue;
    }

    // --- sign -------------------------------------------------------------
    let transaction: VersionedTransaction;
    let signature: string;
    let blockhash: string;
    try {
      transaction = VersionedTransaction.deserialize(
        Buffer.from(built.swapTransaction, 'base64'),
      );
      blockhash = transaction.message.recentBlockhash;
      signature = useUserCustody
        ? await signUserSolanaTransaction(request.userId as string, transaction)
        : solanaSigner.sign(transaction);
      telemetry.mark('signed');
      record(attempt, 'sign', 'ok', `signature=${signature}`, signature);
    } catch (error) {
      lastError = error;
      record(attempt, 'sign', 'error', describe(error));
      return failure(TxStatus.FAILED, 'SIGN_FAILED', describe(error), {
        quotedAmountRaw: quote.quote.outAmount,
      });
    }

    // --- pre-flight against a real validator (time-bounded) ---------------
    // Exits skip preflight entirely — every ms of delay ages the blockhash.
    // Buys keep a short RPC preflight budget; on timeout we still broadcast.
    if (isExit) {
      record(attempt, 'preflight', 'ok', 'skipped-exit-urgency');
    } else {
      const PREFLIGHT_BUDGET_MS = 180;
      const preflight = await Promise.race([
        solanaPool()
          .call('simulateTransaction', (client) =>
            // copyra-audit-allow: `simulateTransaction` is the Solana RPC method
            client.simulateTransaction(transaction, {
              replaceRecentBlockhash: false,
              sigVerify: false,
            }),
          )
          .catch((error: unknown) => {
            log.warn({ err: error }, 'Pre-flight RPC call failed; proceeding to broadcast');
            return null;
          }),
        sleep(PREFLIGHT_BUDGET_MS).then(() => {
          log.warn({ budgetMs: PREFLIGHT_BUDGET_MS }, 'Pre-flight budget exceeded; proceeding to broadcast');
          return null;
        }),
      ]);

      if (preflight?.value.value.err) {
        const detail = JSON.stringify(preflight.value.value.err);
        const logs = preflight.value.value.logs?.slice(-5).join(' | ') ?? '';
        record(attempt, 'preflight', 'error', `${detail} ${logs}`);
        lastError = new Error(`Pre-flight failed: ${detail}`);
        if (attempt === request.maxAttempts) {
          return failure(TxStatus.FAILED, 'PREFLIGHT_FAILED', `${detail} ${logs}`, {
            quotedAmountRaw: quote.quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
            blockhash,
            lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
          });
        }
        continue; // fresh quote + fresh blockhash
      }
      record(
        attempt,
        'preflight',
        'ok',
        preflight ? `units=${preflight.value.value.unitsConsumed ?? 'n/a'}` : 'skipped-budget',
      );
    }

    // --- broadcast ---------------------------------------------------------
    let broadcastSignature: string;
    try {
      const sendResult = await withRetry(
        () =>
          solanaPool().call('sendRawTransaction', (client) =>
            client.sendRawTransaction(transaction.serialize(), {
              skipPreflight: true,
              // Let the RPC rebroadcast briefly while we poll confirmation.
              maxRetries: isExit ? 3 : 0,
              preflightCommitment: 'processed',
            }),
          ),
        {
          attempts: 2,
          baseDelayMs: 40,
          // A duplicate-signature error means it is already out there, which is
          // success for broadcast purposes, so never treat it as retryable.
          retryable: (error) => !/already been processed|duplicate signature/i.test(describe(error)),
        },
      );
      broadcastSignature = sendResult.value;
      telemetry.mark('broadcast');
      record(attempt, 'broadcast', 'ok', `signature=${broadcastSignature}`, broadcastSignature);
    } catch (error) {
      lastError = error;
      const message = describe(error);
      record(attempt, 'broadcast', 'error', message);

      if (/already been processed|duplicate signature/i.test(message)) {
        // The transaction is on the network. Confirm the signature we signed
        // rather than building a new one — this is the duplicate-buy guard.
        broadcastSignature = signature;
        telemetry.mark('broadcast');
        record(attempt, 'broadcast', 'ok', 'Already on the network; confirming the existing signature', signature);
      } else if (attempt === request.maxAttempts) {
        return failure(TxStatus.FAILED, 'BROADCAST_FAILED', message, {
          quotedAmountRaw: quote.quote.outAmount,
          blockhash,
          lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
        });
      } else {
        continue;
      }
    }

    // --- confirm, by reading chain state -----------------------------------
    // Exits: bound confirm wait; expiry polls above fail fast so we rebuild
    // instead of sitting on a dead blockhash for ~60s (32–47s sell lag).
    const confirmBudget = isExit
      ? Math.min(request.confirmTimeoutMs, 12_000)
      : request.confirmTimeoutMs;
    const confirmation = await confirmSolanaTransaction(
      broadcastSignature,
      built.lastValidBlockHeight,
      confirmBudget,
    );
    record(
      attempt,
      'confirm',
      confirmation.status === TxStatus.CONFIRMED ? 'ok' : 'error',
      `${confirmation.status}${confirmation.error ? `: ${confirmation.error}` : ''}`,
      broadcastSignature,
    );

    const shared = {
      txHash: broadcastSignature,
      explorerUrl: explorerTxUrl(Chain.SOLANA, broadcastSignature),
      quotedAmountRaw: quote.quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
      blockhash,
      lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
      routeProvider: 'jupiter',
      routeSummary: {
        route: quote.routeLabels,
        inAmount: quote.quote.inAmount,
        outAmount: quote.quote.outAmount,
        minOutAmount: quote.quote.otherAmountThreshold,
        slippageBps: quote.quote.slippageBps,
        contextSlot: quote.quote.contextSlot ?? null,
        quoteEndpoint: quote.endpoint,
        quoteLatencyMs: quote.latencyMs,
      } as Record<string, unknown>,
      attempts: attempt,
      attemptLog,
      confirmations: confirmation.confirmations,
      telemetry,
    };

    if (confirmation.status === TxStatus.CONFIRMED) {
      telemetry.mark('landed', confirmation.confirmedAt ?? new Date());
      telemetry.mark('confirmed', confirmation.confirmedAt ?? new Date());

      const fill = await readActualFill(broadcastSignature, walletAddress, request.outputMint);
      const quoted = BigInt(quote.quote.outAmount);
      const actual = fill.actualAmountRaw ? BigInt(fill.actualAmountRaw) : null;
      const fillRatio = actual !== null && quoted > 0n ? Number(actual) / Number(quoted) : null;
      const realizedSlippagePct =
        fillRatio !== null ? (1 - fillRatio) * 100 : null;

      if (actual === null) {
        log.warn(
          { signature: broadcastSignature, outputMint: request.outputMint },
          'Transaction confirmed but no output balance delta found for the wallet — flagging for reconciliation',
        );
      }

      return {
        ...shared,
        status: TxStatus.CONFIRMED,
        slot: confirmation.slot,
        actualAmountRaw: fill.actualAmountRaw,
        fillRatio,
        realizedSlippagePct,
        networkFeeRaw: fill.feeRaw,
        errorCode: null,
        errorMessage: null,
      };
    }

    if (confirmation.status === TxStatus.FAILED) {
      // The transaction landed and reverted on-chain. The blockhash is spent;
      // a retry needs a completely fresh quote and transaction.
      lastError = new Error(confirmation.error ?? 'on-chain failure');
      if (attempt === request.maxAttempts) {
        return {
          ...shared,
          status: TxStatus.FAILED,
          slot: confirmation.slot,
          actualAmountRaw: null,
          fillRatio: null,
          realizedSlippagePct: null,
          networkFeeRaw: null,
          errorCode: 'ONCHAIN_FAILURE',
          errorMessage: confirmation.error,
        };
      }
      continue;
    }

    // EXPIRED only: signature never observed and blockhash dead — safe to rebuild.
    // UNKNOWN must not retry with a new tx (risk of double-spend if the first lands).
    if (confirmation.status === TxStatus.EXPIRED && attempt < request.maxAttempts) {
      continue;
    }

    return {
      ...shared,
      status: confirmation.status,
      slot: confirmation.slot,
      actualAmountRaw: null,
      fillRatio: null,
      realizedSlippagePct: null,
      networkFeeRaw: null,
      errorCode: confirmation.status === TxStatus.EXPIRED ? 'BLOCKHASH_EXPIRED' : 'CONFIRMATION_UNKNOWN',
      errorMessage: confirmation.error,
    };
  }

  return failure(TxStatus.FAILED, 'RETRIES_EXHAUSTED', describe(lastError));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Native-SOL and SPL balances for an address, read from chain state. */
export async function getSolanaBalances(address: string): Promise<{
  lamports: bigint;
  tokens: Array<{ mint: string; amountRaw: string; decimals: number }>;
  slot: bigint;
}> {
  const { PublicKey } = await import('@solana/web3.js');
  const pubkey = new PublicKey(address);

  const [lamportsResult, tokenResult, slotResult] = await Promise.all([
    solanaPool().call('getBalance', (client) => client.getBalance(pubkey, 'confirmed')),
    solanaPool().call('getParsedTokenAccountsByOwner', (client) =>
      client.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      }),
    ),
    solanaPool().call('getSlot', (client) => client.getSlot('confirmed')),
  ]);

  const tokens: Array<{ mint: string; amountRaw: string; decimals: number }> = [];
  for (const account of tokenResult.value.value) {
    const info = account.account.data.parsed.info as {
      mint: string;
      tokenAmount: { amount: string; decimals: number };
    };
    if (BigInt(info.tokenAmount.amount) === 0n) continue;
    tokens.push({
      mint: info.mint,
      amountRaw: info.tokenAmount.amount,
      decimals: info.tokenAmount.decimals,
    });
  }

  return {
    lamports: BigInt(lamportsResult.value),
    tokens,
    slot: BigInt(slotResult.value),
  };
}

/**
 * Trading-bucket SOL balance in whole SOL.
 *
 * Reserves the rent-exempt minimum plus a fee buffer, so sizing can never
 * produce a trade that leaves the wallet unable to pay for its own exit.
 */
export const SOL_FEE_BUFFER_LAMPORTS = 10_000_000n; // 0.01 SOL

/**
 * Hot-path SOL balance for copy sizing: native lamports only (no SPL scan).
 * Token-account enumeration stays on getSolanaBalances for display/API.
 */
export async function getSpendableSol(address: string): Promise<{
  spendableSol: number;
  rawLamports: bigint;
  slot: bigint;
}> {
  const { PublicKey } = await import('@solana/web3.js');
  const pubkey = new PublicKey(address);
  const [lamportsResult, slotResult] = await Promise.all([
    solanaPool().call('getBalance', (client) => client.getBalance(pubkey, 'confirmed')),
    solanaPool().call('getSlot', (client) => client.getSlot('confirmed')),
  ]);
  const rawLamports = BigInt(lamportsResult.value);
  const spendable =
    rawLamports > SOL_FEE_BUFFER_LAMPORTS ? rawLamports - SOL_FEE_BUFFER_LAMPORTS : 0n;
  return {
    spendableSol: Number(spendable) / 1e9,
    rawLamports,
    slot: BigInt(slotResult.value),
  };
}

export function lamportsFromSol(sol: number): string {
  return BigInt(Math.floor(sol * 1e9)).toString();
}

export { WRAPPED_SOL_MINT_STR };
export type { JupiterQuote };
