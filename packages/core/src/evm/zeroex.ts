import type { Chain } from '@copyra/db';
import { assertExecutable, chainConfig } from '../config/chains.js';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { fetchJson } from '../util/retry.js';
import { NATIVE_SENTINEL } from './kyberswap.js';

const log = componentLogger('zeroex');

/**
 * Optional 0x Swap API (Allowance Holder) fallback when KyberSwap fails.
 * Only used when ZERO_EX_API_KEY is set — Kyber remains the primary path.
 *
 * API: https://0x.org/docs/api
 */

const BASE_URL = 'https://api.0x.org';

export class NoZeroExRouteError extends Error {
  readonly code = 'NO_ROUTE';
  constructor(chain: Chain, detail: string) {
    super(`No 0x route on ${chain}: ${detail}`);
    this.name = 'NoZeroExRouteError';
  }
}

export function zeroExConfigured(): boolean {
  return Boolean(env.ZERO_EX_API_KEY?.trim());
}

function chainIdFor(chain: Chain): number {
  const config = assertExecutable(chain);
  if (!config.chainId) {
    throw new NoZeroExRouteError(chain, 'no EVM chain id');
  }
  return config.chainId;
}

function toZeroExToken(address: string): string {
  if (address.toLowerCase() === NATIVE_SENTINEL.toLowerCase()) {
    return NATIVE_SENTINEL;
  }
  return address;
}

export interface ZeroExSwapParams {
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountInRaw: string;
  /** Taker / sender address (required by Allowance Holder quotes). */
  taker: string;
  slippageBps: number;
}

export interface ZeroExSwapResult {
  routerAddress: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  amountInUsd: number;
  amountOutUsd: number;
  priceImpactPct: number;
  receivedAt: Date;
  latencyMs: number;
  allowanceTarget: `0x${string}` | null;
}

interface ZeroExQuoteResponse {
  buyAmount?: string;
  sellAmount?: string;
  minBuyAmount?: string;
  allowanceTarget?: string;
  /** USD strings when present. */
  buyToken?: { symbol?: string };
  sellToken?: { symbol?: string };
  totalNetworkFee?: string;
  issues?: { allowance?: { spender: string } | null };
  transaction?: {
    to: string;
    data: string;
    value: string;
    gas?: string;
  };
  /**
   * Some 0x responses include estimated USD; when absent we leave impact at 0
   * and rely on executor slippage / estimateGas guards.
   */
  estimatedPriceImpact?: string | null;
}

/**
 * Fetches an executable 0x Allowance Holder quote.
 * Returns calldata ready to broadcast — no separate build step.
 */
export async function getZeroExSwap(params: ZeroExSwapParams): Promise<ZeroExSwapResult> {
  if (!zeroExConfigured()) {
    throw new NoZeroExRouteError(params.chain, 'ZERO_EX_API_KEY is not configured');
  }
  assertExecutable(params.chain);
  const chainId = chainIdFor(params.chain);

  const query = new URLSearchParams({
    chainId: String(chainId),
    sellToken: toZeroExToken(params.tokenIn),
    buyToken: toZeroExToken(params.tokenOut),
    sellAmount: params.amountInRaw,
    taker: params.taker,
    slippageBps: String(params.slippageBps),
  });

  const started = Date.now();
  const { data } = await fetchJson<ZeroExQuoteResponse>(
    `${BASE_URL}/swap/allowance-holder/quote?${query.toString()}`,
    {
      headers: {
        accept: 'application/json',
        '0x-api-key': env.ZERO_EX_API_KEY!.trim(),
        '0x-version': 'v2',
      },
      timeoutMs: 3_500,
      label: 'zeroex/quote',
    },
  );
  const latencyMs = Date.now() - started;

  if (!data.transaction?.to || !data.transaction.data || !data.buyAmount) {
    log.warn({ chain: params.chain, data }, '0x quote missing transaction');
    throw new NoZeroExRouteError(params.chain, 'quote response missing transaction');
  }

  const amountOut = data.buyAmount;
  const amountOutMin = data.minBuyAmount ?? amountOut;
  const impactRaw = data.estimatedPriceImpact;
  const priceImpactPct =
    impactRaw != null && impactRaw !== ''
      ? Math.abs(Number.parseFloat(impactRaw))
      : 0;

  const allowanceSpender =
    data.issues?.allowance?.spender ?? data.allowanceTarget ?? data.transaction.to;

  return {
    routerAddress: data.transaction.to as `0x${string}`,
    data: data.transaction.data as `0x${string}`,
    value: BigInt(data.transaction.value ?? '0'),
    amountIn: data.sellAmount ?? params.amountInRaw,
    amountOut,
    amountOutMin,
    amountInUsd: 0,
    amountOutUsd: 0,
    priceImpactPct: Number.isFinite(priceImpactPct) ? priceImpactPct : 0,
    receivedAt: new Date(),
    latencyMs,
    allowanceTarget: allowanceSpender
      ? (allowanceSpender as `0x${string}`)
      : null,
  };
}

/** Probe whether 0x answers for this chain (used by live provider checks). */
export async function probeZeroExChainSupport(chain: Chain): Promise<boolean> {
  if (!zeroExConfigured()) return false;
  try {
    const config = chainConfig(chain);
    if (!config.chainId || !config.quoteAsset || !config.stableAsset) return false;
    // Lightweight: just confirm the API key + chain are accepted with a tiny quote.
    // Caller must supply a real taker in production; probe uses zero address and
    // may return an issues block — any HTTP 200 with buyAmount counts as support.
    const query = new URLSearchParams({
      chainId: String(config.chainId),
      sellToken: config.quoteAsset,
      buyToken: config.stableAsset,
      sellAmount: (10n ** BigInt(Math.max(config.quoteAssetDecimals - 2, 0))).toString(),
      // 0x rejects near-zero takers; use a non-special address for the probe.
      taker: '0x1111111111111111111111111111111111111111',
      slippageBps: '100',
    });
    const { data } = await fetchJson<ZeroExQuoteResponse>(
      `${BASE_URL}/swap/allowance-holder/quote?${query.toString()}`,
      {
        headers: {
          accept: 'application/json',
          '0x-api-key': env.ZERO_EX_API_KEY!.trim(),
          '0x-version': 'v2',
        },
        timeoutMs: 3_500,
        label: 'zeroex/probe',
      },
    );
    return Boolean(data.buyAmount);
  } catch (error) {
    log.warn({ chain, err: error }, '0x support probe failed');
    return false;
  }
}
