import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { fetchJson, withRetry } from '../util/retry.js';

const log = componentLogger('jupiter');

/**
 * Jupiter swap integration.
 *
 * Quotes and swap transactions come from Jupiter's live aggregator. The
 * returned transaction is a real, unsigned, base64 VersionedTransaction built
 * against current pool state — COPYRA signs and broadcasts it unchanged.
 *
 * The Pro endpoint is used when JUPITER_API_KEY is set, with the keyless Lite
 * endpoint as an automatic fallback, because a key problem should degrade
 * routing quality rather than stop trading.
 */

const LITE_BASE = 'https://lite-api.jup.ag';

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  /** Minimum out at the requested slippage. The on-chain guarantee. */
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label?: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot?: number;
  timeTaken?: number;
}

export interface QuoteResult {
  quote: JupiterQuote;
  /** Local time the quote was received, used to enforce the staleness guard. */
  receivedAt: Date;
  latencyMs: number;
  endpoint: string;
  priceImpactPct: number;
  routeLabels: string[];
}

function headers(): Record<string, string> {
  const base: Record<string, string> = { accept: 'application/json' };
  if (env.JUPITER_API_KEY) base['x-api-key'] = env.JUPITER_API_KEY;
  return base;
}

function bases(): string[] {
  return env.JUPITER_API_KEY ? [env.JUPITER_API_BASE, LITE_BASE] : [LITE_BASE];
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Base units of the input mint. */
  amountRaw: string;
  slippageBps: number;
  /** Restrict to direct routes for lower latency and simpler failure modes. */
  onlyDirectRoutes?: boolean;
  /** ExactIn for buys; ExactIn on the token amount for sells. */
  swapMode?: 'ExactIn' | 'ExactOut';
}

export class NoRouteError extends Error {
  readonly code = 'NO_ROUTE';
  constructor(params: QuoteParams, detail: string) {
    super(
      `No Jupiter route for ${params.amountRaw} of ${params.inputMint} -> ${params.outputMint}: ${detail}`,
    );
    this.name = 'NoRouteError';
  }
}

export async function getJupiterQuote(params: QuoteParams): Promise<QuoteResult> {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountRaw,
    slippageBps: String(params.slippageBps),
    swapMode: params.swapMode ?? 'ExactIn',
  });
  if (params.onlyDirectRoutes) query.set('onlyDirectRoutes', 'true');

  let lastError: unknown;
  for (const base of bases()) {
    try {
      const { data, latencyMs } = await withRetry(
        () =>
          fetchJson<JupiterQuote & { error?: string }>(
            `${base}/swap/v1/quote?${query.toString()}`,
            { headers: headers(), timeoutMs: 5_000, label: 'jupiter/quote' },
          ),
        { attempts: 2, baseDelayMs: 120 },
      );

      if (data.error || !data.outAmount) {
        throw new NoRouteError(params, data.error ?? 'empty outAmount');
      }

      const impact = Number.parseFloat(data.priceImpactPct ?? '0');
      return {
        quote: data,
        receivedAt: new Date(),
        latencyMs,
        endpoint: base,
        priceImpactPct: Number.isFinite(impact) ? impact * 100 : 0,
        routeLabels: (data.routePlan ?? []).map((r) => r.swapInfo.label ?? r.swapInfo.ammKey),
      };
    } catch (error) {
      lastError = error;
      log.warn({ base, err: error }, 'Jupiter quote endpoint failed, trying next');
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new NoRouteError(params, 'all Jupiter endpoints failed');
}

export interface SwapBuildParams {
  quote: JupiterQuote;
  userPublicKey: string;
  /** Jupiter creates/closes the wrapped-SOL account for us when true. */
  wrapAndUnwrapSol?: boolean;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
}

export interface SwapBuildResult {
  /** Base64 unsigned VersionedTransaction. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  latencyMs: number;
}

/**
 * Builds the swap transaction. Returned unsigned so the signing step is always
 * explicit and auditable — the same endpoint serves both bot execution and
 * user-wallet signing in the dashboard.
 */
export async function buildJupiterSwap(params: SwapBuildParams): Promise<SwapBuildResult> {
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: params.priorityFeeMicroLamports ?? env.SOLANA_MAX_PRIORITY_FEE_MICROLAMPORTS,
        priorityLevel: 'high',
      },
    },
  };

  let lastError: unknown;
  for (const base of bases()) {
    try {
      const { data, latencyMs } = await fetchJson<{
        swapTransaction: string;
        lastValidBlockHeight: number;
        prioritizationFeeLamports?: number;
        computeUnitLimit?: number;
        error?: string;
      }>(`${base}/swap/v1/swap`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 8_000,
        label: 'jupiter/swap',
      });

      if (data.error || !data.swapTransaction) {
        throw new Error(`Jupiter swap build failed: ${data.error ?? 'no transaction returned'}`);
      }
      return {
        swapTransaction: data.swapTransaction,
        lastValidBlockHeight: data.lastValidBlockHeight,
        prioritizationFeeLamports: data.prioritizationFeeLamports,
        computeUnitLimit: data.computeUnitLimit,
        latencyMs,
      };
    } catch (error) {
      lastError = error;
      log.warn({ base, err: error }, 'Jupiter swap build failed, trying next endpoint');
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All Jupiter swap endpoints failed');
}

export interface JupiterPrice {
  usdPrice: number;
  decimals: number;
  liquidity?: number;
  priceChange24h?: number;
  blockId?: number;
}

/**
 * Live USD prices. `blockId` is retained because it proves which chain state
 * the price came from — important when reconciling a position mark.
 */
export async function getJupiterPrices(mints: string[]): Promise<Map<string, JupiterPrice>> {
  const out = new Map<string, JupiterPrice>();
  if (mints.length === 0) return out;

  // The endpoint accepts a bounded id list; chunk to stay well inside it.
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 50) chunks.push(mints.slice(i, i + 50));

  for (const chunk of chunks) {
    for (const base of bases()) {
      try {
        const { data } = await fetchJson<Record<string, JupiterPrice | null>>(
          `${base}/price/v3?ids=${chunk.join(',')}`,
          { headers: headers(), timeoutMs: 5_000, label: 'jupiter/price' },
        );
        for (const [mint, price] of Object.entries(data)) {
          if (price && Number.isFinite(price.usdPrice) && price.usdPrice > 0) {
            out.set(mint, price);
          }
        }
        break;
      } catch (error) {
        log.warn({ base, err: error }, 'Jupiter price endpoint failed');
      }
    }
  }
  return out;
}

export async function getSolPriceUsd(): Promise<number> {
  const mint = 'So11111111111111111111111111111111111111112';
  const prices = await getJupiterPrices([mint]);
  const price = prices.get(mint);
  if (!price) {
    throw new Error('SOL price unavailable from Jupiter; refusing to size a trade without it.');
  }
  return price.usdPrice;
}
