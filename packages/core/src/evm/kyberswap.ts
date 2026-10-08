import type { Chain } from '@copyra/db';
import { assertExecutable, chainConfig } from '../config/chains.js';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { fetchJson, withRetry } from '../util/retry.js';

const log = componentLogger('kyberswap');

/**
 * KyberSwap Aggregator integration.
 *
 * Two-step by design: `/routes` returns a route summary, then `/route/build`
 * turns it into real calldata bound to the caller's address and slippage. The
 * build step is what produces an executable transaction, so the route is always
 * re-validated before signing rather than cached.
 */

const BASE_URL = 'https://aggregator-api.kyberswap.com';

/** The sentinel KyberSwap uses for native ETH/BNB/POL. */
export const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export interface KyberRouteSummary {
  tokenIn: string;
  amountIn: string;
  amountInUsd: string;
  tokenOut: string;
  amountOut: string;
  amountOutUsd: string;
  gas: string;
  gasPrice: string;
  gasUsd: string;
  route: unknown[];
  [key: string]: unknown;
}

export interface KyberRouteResult {
  routeSummary: KyberRouteSummary;
  routerAddress: string;
  receivedAt: Date;
  latencyMs: number;
  /** Derived from the USD legs the aggregator reports. */
  priceImpactPct: number;
  amountOutRaw: string;
  amountInUsd: number;
  amountOutUsd: number;
}

export class NoKyberRouteError extends Error {
  readonly code = 'NO_ROUTE';
  constructor(chain: Chain, detail: string) {
    super(`No KyberSwap route on ${chain}: ${detail}`);
    this.name = 'NoKyberRouteError';
  }
}

function headers(): Record<string, string> {
  return {
    accept: 'application/json',
    'x-client-id': env.KYBERSWAP_CLIENT_ID,
  };
}

function kyberSlug(chain: Chain): string {
  const config = assertExecutable(chain);
  if (!config.kyberSlug) {
    throw new NoKyberRouteError(chain, 'no KyberSwap network slug is configured for this chain');
  }
  return config.kyberSlug;
}

export interface RouteParams {
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountInRaw: string;
}

export async function getKyberRoute(params: RouteParams): Promise<KyberRouteResult> {
  const slug = kyberSlug(params.chain);
  const query = new URLSearchParams({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountInRaw,
    gasInclude: 'true',
  });

  const { data, latencyMs } = await withRetry(
    () =>
      fetchJson<{
        code: number;
        message: string;
        data?: { routeSummary: KyberRouteSummary; routerAddress: string };
      }>(`${BASE_URL}/${slug}/api/v1/routes?${query.toString()}`, {
        headers: headers(),
        timeoutMs: 2_500,
        label: 'kyberswap/routes',
      }),
    { attempts: 2, baseDelayMs: 40 },
  );

  if (data.code !== 0 || !data.data?.routeSummary) {
    throw new NoKyberRouteError(params.chain, data.message || `code ${data.code}`);
  }

  const summary = data.data.routeSummary;
  const amountInUsd = Number.parseFloat(summary.amountInUsd ?? '0');
  const amountOutUsd = Number.parseFloat(summary.amountOutUsd ?? '0');

  // KyberSwap does not return a price-impact field, so it is derived from the
  // USD value the route destroys. Gas is excluded because it is a separate cost.
  const priceImpactPct =
    amountInUsd > 0 && amountOutUsd > 0 ? ((amountInUsd - amountOutUsd) / amountInUsd) * 100 : 0;

  return {
    routeSummary: summary,
    routerAddress: data.data.routerAddress,
    receivedAt: new Date(),
    latencyMs,
    priceImpactPct,
    amountOutRaw: summary.amountOut,
    amountInUsd,
    amountOutUsd,
  };
}

export interface BuildParams {
  chain: Chain;
  route: KyberRouteResult;
  sender: string;
  recipient: string;
  slippageBps: number;
  /** Unix seconds. The router reverts after this. */
  deadline: number;
}

export interface KyberBuildResult {
  routerAddress: `0x${string}`;
  data: `0x${string}`;
  /** Native value to attach, in wei. */
  value: bigint;
  gas: bigint;
  amountIn: string;
  amountOut: string;
  /** Guaranteed minimum out at the requested slippage. */
  amountOutMin: string;
  latencyMs: number;
}

export async function buildKyberSwap(params: BuildParams): Promise<KyberBuildResult> {
  const slug = kyberSlug(params.chain);

  const { data, latencyMs } = await fetchJson<{
    code: number;
    message: string;
    data?: {
      amountIn: string;
      amountOut: string;
      gas: string;
      data: string;
      routerAddress: string;
      transactionValue: string;
    };
  }>(`${BASE_URL}/${slug}/api/v1/route/build`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({
      routeSummary: params.route.routeSummary,
      sender: params.sender,
      recipient: params.recipient,
      slippageTolerance: params.slippageBps,
      deadline: params.deadline,
      source: env.KYBERSWAP_CLIENT_ID,
    }),
    timeoutMs: 2_500,
    label: 'kyberswap/route/build',
  });

  if (data.code !== 0 || !data.data) {
    throw new NoKyberRouteError(params.chain, `build failed: ${data.message || data.code}`);
  }

  const built = data.data;
  const amountOut = BigInt(built.amountOut);
  const amountOutMin = (amountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;

  return {
    routerAddress: built.routerAddress as `0x${string}`,
    data: built.data as `0x${string}`,
    value: BigInt(built.transactionValue ?? '0'),
    gas: BigInt(built.gas || '0'),
    amountIn: built.amountIn,
    amountOut: built.amountOut,
    amountOutMin: amountOutMin.toString(),
    latencyMs,
  };
}

/**
 * Converts a chain-level asset reference into the form KyberSwap expects.
 * Native assets must be passed as the sentinel, not as the wrapped contract,
 * or the route will quote a wrap the caller never asked for.
 */
export function toKyberAsset(chain: Chain, address: string, useNative: boolean): string {
  if (useNative) return NATIVE_SENTINEL;
  const config = chainConfig(chain);
  return address || config.quoteAsset;
}

export function isNativeSentinel(address: string): boolean {
  return address.toLowerCase() === NATIVE_SENTINEL;
}

export async function probeKyberChainSupport(chain: Chain): Promise<boolean> {
  try {
    const config = chainConfig(chain);
    if (!config.kyberSlug || !config.quoteAsset || !config.stableAsset) return false;
    await getKyberRoute({
      chain,
      tokenIn: config.quoteAsset,
      tokenOut: config.stableAsset,
      amountInRaw: (10n ** BigInt(config.quoteAssetDecimals - 2)).toString(),
    });
    return true;
  } catch (error) {
    log.warn({ chain, err: error }, 'KyberSwap support probe failed');
    return false;
  }
}
