import { Chain, TxStatus } from '@copyra/db';
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  type TransactionReceipt,
} from 'viem';
import { assertExecutable, chainConfig, explorerTxUrl } from '../config/chains.js';
import type { TelemetryTracker } from '../engine/telemetry.js';
import { componentLogger } from '../obs/logger.js';
import { evmSigner, NoSignerError } from '../security/signer.js';
import { multiUserCustodyEnabled, userEvmAccount } from '../security/user-custody.js';
import { sleep } from '../util/retry.js';
import { evmPool, viemChain } from './clients.js';
import { computeEvmTokenDeltas } from './decoder.js';
import {
  buildKyberSwap,
  getKyberRoute,
  isNativeSentinel,
  NATIVE_SENTINEL,
  type KyberBuildResult,
  type KyberRouteResult,
} from './kyberswap.js';
import { getErc20Allowance, getErc20Metadata, getNativeBalance } from './tokens.js';
import { getZeroExSwap, zeroExConfigured } from './zeroex.js';
import type { AttemptRecord, ExecutionOutcome } from '../solana/executor.js';

const log = componentLogger('evm-executor');

export interface EvmSwapRequest {
  chain: Chain;
  /** Use NATIVE_SENTINEL to spend native ETH/BNB/POL. */
  tokenIn: string;
  tokenOut: string;
  amountInRaw: string;
  slippageBps: number;
  maxPriceImpactPct: number;
  quoteMaxAgeMs: number;
  confirmTimeoutMs: number;
  maxAttempts: number;
  telemetry: TelemetryTracker;
  idempotencyKey: string;
  /** When set with multi-user custody, spend/sign from that account's custody wallet. */
  userId?: string;
}

/**
 * Confirms an EVM transaction by reading the receipt.
 *
 * `receipt.status === 'success'` is the only acceptable proof of execution. A
 * successful `eth_sendRawTransaction` returns a hash for a transaction that has
 * not executed yet and may still revert; it maps to BROADCAST.
 *
 * A reverted transaction is FAILED and consumed its gas — which is why the
 * swap path pre-simulates via `eth_call` before signing.
 */
export async function confirmEvmTransaction(
  chain: Chain,
  txHash: `0x${string}`,
  timeoutMs: number,
  requiredConfirmations: number,
): Promise<{
  status: TxStatus;
  receipt: TransactionReceipt | null;
  confirmations: number;
  error: string | null;
}> {
  const config = chainConfig(chain);
  const deadline = Date.now() + timeoutMs;
  // Fast receipt polls — Base/Arb often land under 1s; start tight, then ease.
  let interval = Math.max(50, Math.min(200, Math.floor(config.blockTimeMs / 6) || 80));

  while (Date.now() < deadline) {
    const result = await evmPool(chain)
      .call('getTransactionReceipt', (client) => client.getTransactionReceipt({ hash: txHash }))
      .catch(() => null);

    if (result?.value) {
      const receipt = result.value;
      if (receipt.status !== 'success') {
        return {
          status: TxStatus.FAILED,
          receipt,
          confirmations: 1,
          error: `Transaction reverted on-chain in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed}.`,
        };
      }

      // requiredConfirmations is 1 on all venues — receipt success is enough.
      if (requiredConfirmations <= 1) {
        return { status: TxStatus.CONFIRMED, receipt, confirmations: 1, error: null };
      }

      const headResult = await evmPool(chain)
        .call('getBlockNumber', (client) => client.getBlockNumber())
        .catch(() => null);
      const confirmations = headResult
        ? Number(headResult.value - receipt.blockNumber) + 1
        : 1;

      if (confirmations >= requiredConfirmations) {
        return { status: TxStatus.CONFIRMED, receipt, confirmations, error: null };
      }
      await sleep(interval);
      continue;
    }

    await sleep(interval);
    interval = Math.min(500, Math.round(interval * 1.25));
  }

  return {
    status: TxStatus.UNKNOWN,
    receipt: null,
    confirmations: 0,
    error: `No receipt within ${timeoutMs}ms. Status is genuinely unknown and will be reconciled against the chain.`,
  };
}

/**
 * Ensures the router can move the token, then returns the approval hash if one
 * was needed.
 *
 * Approves exactly `maxUint256` to the router only when the existing allowance
 * is insufficient. An unlimited approval to an aggregator router is the normal
 * trade-off here: the alternative is an extra approval transaction before every
 * sell, which costs an extra block of latency at exit time — exactly when
 * latency matters most.
 */
async function ensureAllowance(
  chain: Chain,
  token: string,
  owner: string,
  router: string,
  amountRaw: bigint,
  confirmTimeoutMs: number,
  account: Awaited<ReturnType<typeof userEvmAccount>>,
): Promise<{ approvalHash: string | null }> {
  if (isNativeSentinel(token)) return { approvalHash: null };

  const current = await getErc20Allowance(chain, token, owner, router);
  if (current >= amountRaw) return { approvalHash: null };

  const wallet = createWalletClient({
    account,
    chain: viemChain(chain),
    transport: http(chainConfig(chain).rpcUrl as string, { timeout: 15_000 }),
  });

  log.info({ chain, token, router }, 'Submitting ERC-20 approval for the aggregator router');

  const hash = await wallet.writeContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: 'approve',
    args: [getAddress(router), maxUint256],
    chain: viemChain(chain),
  });

  const confirmation = await confirmEvmTransaction(
    chain,
    hash,
    confirmTimeoutMs,
    chainConfig(chain).requiredConfirmations,
  );
  if (confirmation.status !== TxStatus.CONFIRMED) {
    throw new Error(
      `Approval transaction ${hash} did not confirm (${confirmation.status}): ${confirmation.error ?? 'unknown'}. ` +
        'The swap was not attempted.',
    );
  }
  return { approvalHash: hash };
}

/**
 * Executes a real EVM swap through KyberSwap.
 *
 * Route -> guards -> allowance -> eth_estimateGas pre-flight -> sign ->
 * broadcast -> receipt -> read back the actual fill from Transfer logs.
 */
export async function executeEvmSwap(request: EvmSwapRequest): Promise<ExecutionOutcome> {
  const { chain, telemetry } = request;
  const config = assertExecutable(chain);
  const attemptLog: AttemptRecord[] = [];

  const record = (
    attempt: number,
    stage: string,
    outcome: 'ok' | 'error',
    detail: string,
    txHash?: string,
  ): void => {
    attemptLog.push({
      attempt,
      at: new Date().toISOString(),
      stage,
      outcome,
      detail,
      ...(txHash ? { txHash } : {}),
    });
  };

  const failure = (
    errorCode: string,
    errorMessage: string,
    extra: Partial<ExecutionOutcome> = {},
  ): ExecutionOutcome => ({
    status: TxStatus.FAILED,
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
    routeProvider: extra.routeProvider ?? 'kyberswap',
    routeSummary: null,
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
  if (!useUserCustody && !evmSigner.available) {
    record(0, 'sign', 'error', 'No EVM signing key configured');
    return failure('NO_SIGNER', new NoSignerError('evm').message);
  }
  let account: ReturnType<typeof evmSigner.requireAccount>;
  let sender: `0x${string}`;
  try {
    if (useUserCustody) {
      account = await userEvmAccount(request.userId as string);
      sender = account.address;
    } else {
      account = evmSigner.requireAccount();
      sender = evmSigner.requireAddress();
    }
  } catch (error) {
    record(0, 'sign', 'error', describe(error));
    return failure('NO_SIGNER', describe(error));
  }
  log.info(
    { wallet: sender, userId: request.userId ?? null, custody: useUserCustody, chain },
    'EVM swap will spend from trading wallet',
  );

  let lastError: unknown;

  for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
    // --- route ------------------------------------------------------------
    // KyberSwap is primary. Optional 0x fallback only when Kyber quote fails
    // and ZERO_EX_API_KEY is set — sizing / impact / slippage guards stay identical.
    let routeProvider: 'kyberswap' | 'zeroex' = 'kyberswap';
    let route: {
      amountOutRaw: string;
      amountInUsd: number;
      amountOutUsd: number;
      priceImpactPct: number;
      receivedAt: Date;
      latencyMs: number;
      routeSummary: KyberRouteResult['routeSummary'] | null;
    };
    let built: KyberBuildResult | null = null;
    let allowanceSpender: `0x${string}` | null = null;

    try {
      const kyber = await getKyberRoute({
        chain,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountInRaw: request.amountInRaw,
      });
      route = {
        amountOutRaw: kyber.amountOutRaw,
        amountInUsd: kyber.amountInUsd,
        amountOutUsd: kyber.amountOutUsd,
        priceImpactPct: kyber.priceImpactPct,
        receivedAt: kyber.receivedAt,
        latencyMs: kyber.latencyMs,
        routeSummary: kyber.routeSummary,
      };
      telemetry.mark('quoted');
      record(
        attempt,
        'quote',
        'ok',
        `provider=kyberswap out=${route.amountOutRaw} inUsd=${route.amountInUsd} outUsd=${route.amountOutUsd} impact=${route.priceImpactPct.toFixed(4)}%`,
      );

      built = await buildKyberSwap({
        chain,
        route: kyber,
        sender,
        recipient: sender,
        slippageBps: request.slippageBps,
        deadline: Math.floor(Date.now() / 1000) + 300,
      });
      telemetry.mark('built');
      record(attempt, 'build', 'ok', `router=${built.routerAddress} minOut=${built.amountOutMin}`);
      allowanceSpender = built.routerAddress;
    } catch (kyberError) {
      if (!zeroExConfigured()) {
        lastError = kyberError;
        record(attempt, 'quote', 'error', describe(kyberError));
        if (attempt === request.maxAttempts) return failure('QUOTE_FAILED', describe(kyberError));
        await sleep(40 * attempt);
        continue;
      }
      try {
        const zerox = await getZeroExSwap({
          chain,
          tokenIn: request.tokenIn,
          tokenOut: request.tokenOut,
          amountInRaw: request.amountInRaw,
          taker: sender,
          slippageBps: request.slippageBps,
        });
        routeProvider = 'zeroex';
        route = {
          amountOutRaw: zerox.amountOut,
          amountInUsd: zerox.amountInUsd,
          amountOutUsd: zerox.amountOutUsd,
          priceImpactPct: zerox.priceImpactPct,
          receivedAt: zerox.receivedAt,
          latencyMs: zerox.latencyMs,
          routeSummary: null,
        };
        built = {
          routerAddress: zerox.routerAddress,
          data: zerox.data,
          value: zerox.value,
          gas: 0n,
          amountIn: zerox.amountIn,
          amountOut: zerox.amountOut,
          amountOutMin: zerox.amountOutMin,
          latencyMs: zerox.latencyMs,
        };
        allowanceSpender = zerox.allowanceTarget ?? zerox.routerAddress;
        telemetry.mark('quoted');
        telemetry.mark('built');
        record(
          attempt,
          'quote',
          'ok',
          `provider=zeroex (kyber failed: ${describe(kyberError)}) out=${route.amountOutRaw} impact=${route.priceImpactPct.toFixed(4)}%`,
        );
        record(attempt, 'build', 'ok', `router=${built.routerAddress} minOut=${built.amountOutMin}`);
      } catch (zeroExError) {
        lastError = zeroExError;
        record(
          attempt,
          'quote',
          'error',
          `kyber=${describe(kyberError)}; zeroex=${describe(zeroExError)}`,
        );
        if (attempt === request.maxAttempts) {
          return failure('QUOTE_FAILED', describe(kyberError));
        }
        await sleep(40 * attempt);
        continue;
      }
    }

    // Sells/exits (token → native) use a higher ceiling so TP/SL can land on thin books.
    const isExit = request.tokenOut.toLowerCase() === NATIVE_SENTINEL.toLowerCase();
    const impactCeiling = isExit
      ? Math.max(request.maxPriceImpactPct, 25)
      : request.maxPriceImpactPct;
    if (route.priceImpactPct > impactCeiling) {
      const message = `Price impact ${route.priceImpactPct.toFixed(4)}% exceeds the ${impactCeiling}% limit; refusing the swap.`;
      record(attempt, 'guard', 'error', message);
      return failure('PRICE_IMPACT_TOO_HIGH', message, {
        priceImpactPct: route.priceImpactPct,
        quotedAmountRaw: route.amountOutRaw,
        routeProvider,
      });
    }

    const routeAgeMs = Date.now() - route.receivedAt.getTime();
    if (routeAgeMs > request.quoteMaxAgeMs) {
      record(attempt, 'guard', 'error', `Route ${routeAgeMs}ms old, over the ${request.quoteMaxAgeMs}ms limit; re-routing`);
      continue;
    }

    if (!built || !allowanceSpender) {
      return failure('BUILD_FAILED', 'No executable route after quote');
    }

    // --- allowance --------------------------------------------------------
    try {
      const { approvalHash } = await ensureAllowance(
        chain,
        request.tokenIn,
        sender,
        allowanceSpender,
        BigInt(request.amountInRaw),
        request.confirmTimeoutMs,
        account,
      );
      if (approvalHash) record(attempt, 'approve', 'ok', `hash=${approvalHash}`, approvalHash);
    } catch (error) {
      lastError = error;
      record(attempt, 'approve', 'error', describe(error));
      return failure('APPROVAL_FAILED', describe(error), {
        quotedAmountRaw: route.amountOutRaw,
        routeProvider,
      });
    }

    // --- gas + native balance guard ---------------------------------------
    let gasLimit: bigint;
    try {
      const estimate = await evmPool(chain).call('estimateGas', (client) =>
        client.estimateGas({
          account,
          to: built.routerAddress,
          data: built.data,
          value: built.value,
        }),
      );
      // 25% headroom: aggregator routes touch variable numbers of pools.
      gasLimit = (estimate.value * 125n) / 100n;
      record(attempt, 'estimateGas', 'ok', `gas=${gasLimit}`);
    } catch (error) {
      // A failing estimate is a real revert signal from live chain state.
      lastError = error;
      record(attempt, 'estimateGas', 'error', describe(error));
      if (attempt === request.maxAttempts) {
        return failure('PREFLIGHT_FAILED', `eth_estimateGas reverted: ${describe(error)}`, {
          quotedAmountRaw: route.amountOutRaw,
          priceImpactPct: route.priceImpactPct,
        });
      }
      continue;
    }

    const feeData = await evmPool(chain)
      .call('getGasPrice', (client) => client.getGasPrice())
      .catch(() => null);
    const gasPrice = feeData?.value ?? 0n;
    const native = await getNativeBalance(chain, sender);
    const requiredNative = built.value + gasLimit * gasPrice;
    if (native.amountRaw < requiredNative) {
      const message =
        `Insufficient ${config.nativeSymbol}: have ${native.amountRaw}, need ${requiredNative} ` +
        `(${built.value} value + ${gasLimit} gas x ${gasPrice}).`;
      record(attempt, 'guard', 'error', message);
      return failure('INSUFFICIENT_BALANCE', message, { quotedAmountRaw: route.amountOutRaw });
    }

    // --- sign + broadcast -------------------------------------------------
    let txHash: `0x${string}`;
    let nonce: number | undefined;
    try {
      const nonceResult = await evmPool(chain).call('getTransactionCount', (client) =>
        client.getTransactionCount({ address: sender, blockTag: 'pending' }),
      );
      nonce = nonceResult.value;

      const wallet = createWalletClient({
        account,
        chain: viemChain(chain),
        transport: http(config.rpcUrl as string, { timeout: 15_000 }),
      });

      const signed = await wallet.signTransaction({
        to: built.routerAddress,
        data: built.data,
        value: built.value,
        gas: gasLimit,
        nonce,
        chain: viemChain(chain),
      });
      telemetry.mark('signed');
      record(attempt, 'sign', 'ok', `nonce=${nonce}`);

      const sendResult = await evmPool(chain).call('sendRawTransaction', (client) =>
        client.sendRawTransaction({ serializedTransaction: signed }),
      );
      txHash = sendResult.value;
      telemetry.mark('broadcast');
      record(attempt, 'broadcast', 'ok', `hash=${txHash}`, txHash);
    } catch (error) {
      lastError = error;
      const message = describe(error);
      record(attempt, 'broadcast', 'error', message);

      if (/nonce too low|already known|replacement transaction underpriced/i.test(message)) {
        // The nonce was consumed. Do not resubmit: a second transaction at a
        // fresh nonce would be a duplicate buy. Reconciliation resolves it.
        return failure('NONCE_CONFLICT', message, {
          status: TxStatus.UNKNOWN,
          quotedAmountRaw: route.amountOutRaw,
          nonce,
        } as Partial<ExecutionOutcome>);
      }
      if (attempt === request.maxAttempts) {
        return failure('BROADCAST_FAILED', message, { quotedAmountRaw: route.amountOutRaw });
      }
      continue;
    }

    // --- confirm ----------------------------------------------------------
    const confirmation = await confirmEvmTransaction(
      chain,
      txHash,
      request.confirmTimeoutMs,
      config.requiredConfirmations,
    );
    record(
      attempt,
      'confirm',
      confirmation.status === TxStatus.CONFIRMED ? 'ok' : 'error',
      `${confirmation.status}${confirmation.error ? `: ${confirmation.error}` : ''}`,
      txHash,
    );

    const shared = {
      txHash,
      explorerUrl: explorerTxUrl(chain, txHash),
      quotedAmountRaw: route.amountOutRaw,
      priceImpactPct: route.priceImpactPct,
      blockhash: null,
      lastValidBlockHeight: null,
      routeProvider,
      routeSummary: {
        router: built.routerAddress,
        amountIn: built.amountIn,
        amountOut: built.amountOut,
        amountOutMin: built.amountOutMin,
        amountInUsd: route.amountInUsd,
        amountOutUsd: route.amountOutUsd,
        gasLimit: gasLimit.toString(),
        gasPrice: gasPrice.toString(),
        routeLatencyMs: route.latencyMs,
        provider: routeProvider,
      } as Record<string, unknown>,
      attempts: attempt,
      attemptLog,
      confirmations: confirmation.confirmations,
      telemetry,
    };

    if (confirmation.status === TxStatus.CONFIRMED && confirmation.receipt) {
      const receipt = confirmation.receipt;
      telemetry.mark('landed');
      telemetry.mark('confirmed');

      // Actual fill, from the Transfer logs of the confirmed transaction.
      const deltas = computeEvmTokenDeltas(receipt.logs, sender);
      const outKey = isNativeSentinel(request.tokenOut)
        ? config.quoteAsset.toLowerCase()
        : request.tokenOut.toLowerCase();
      const delta = deltas.get(outKey);
      const actual = delta !== undefined && delta > 0n ? delta : null;
      const quoted = BigInt(route.amountOutRaw);
      const fillRatio = actual !== null && quoted > 0n ? Number(actual) / Number(quoted) : null;

      if (actual === null) {
        log.warn(
          { chain, txHash, tokenOut: request.tokenOut },
          'Receipt confirmed but no inbound Transfer for the expected token — flagging for reconciliation',
        );
      }

      return {
        ...shared,
        status: TxStatus.CONFIRMED,
        slot: receipt.blockNumber,
        actualAmountRaw: actual !== null ? actual.toString() : null,
        fillRatio,
        realizedSlippagePct: fillRatio !== null ? (1 - fillRatio) * 100 : null,
        networkFeeRaw: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        errorCode: null,
        errorMessage: null,
      };
    }

    return {
      ...shared,
      status: confirmation.status,
      slot: confirmation.receipt?.blockNumber ?? null,
      actualAmountRaw: null,
      fillRatio: null,
      realizedSlippagePct: null,
      networkFeeRaw: confirmation.receipt
        ? (confirmation.receipt.gasUsed * confirmation.receipt.effectiveGasPrice).toString()
        : null,
      errorCode: confirmation.status === TxStatus.FAILED ? 'ONCHAIN_REVERT' : 'CONFIRMATION_UNKNOWN',
      errorMessage: confirmation.error,
    };
  }

  return failure('RETRIES_EXHAUSTED', describe(lastError));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // viem errors carry a long formatted body; keep the actionable head.
    return error.message.split('\n').slice(0, 4).join(' ').slice(0, 600);
  }
  return String(error);
}

export { NATIVE_SENTINEL, getErc20Metadata };
