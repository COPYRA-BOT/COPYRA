import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { fetchJson, HttpError, sleep, withRetry } from '../util/retry.js';

const log = componentLogger('jupiter');

/**
 * Jupiter swap integration.
 *
 * Quotes and swap transactions come from Jupiter's live aggregator. The
 * returned transaction is a real, unsigned, base64 VersionedTransaction built
 * against current pool state — COPYRA signs and broadcasts it unchanged.
 *
 * When JUPITER_API_KEY is set we stay on the Pro endpoint. Lite is only used
 * as a fallback for non-rate-limit failures (bad/missing key). Falling through
 * to Lite on HTTP 429 makes exits worse — Lite is tighter than Pro.
 */

const LITE_BASE = 'https://lite-api.jup.ag';

/** Short TTL so exit ticks (250ms) reuse marks instead of hammering /price. */
const PRICE_CACHE_TTL_MS = 2_000;
/** Serve slightly stale prices during a 429 cooldown rather than failing marks. */
const PRICE_STALE_OK_MS = 15_000;
/** After a 429, pause Pro calls briefly so buy/exit quotes recover. */
const RATE_LIMIT_COOLDOWN_MS = 800;
/** Hot-path HTTP budget — 900ms caused stop-loss QUOTE_FAILED under load. */
const JUPITER_HTTP_TIMEOUT_MS = 1_800;
const JUPITER_HTTP_TIMEOUT_EXIT_MS = 3_200;

export type JupiterUrgency = 'normal' | 'exit';

export function jupiterHttpTimeoutMs(urgency: JupiterUrgency = 'normal'): number {
  return urgency === 'exit' ? JUPITER_HTTP_TIMEOUT_EXIT_MS : JUPITER_HTTP_TIMEOUT_MS;
}

const priceCache = new Map<string, { price: JupiterPrice; at: number }>();
let rateLimitedUntil = 0;

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
    };
    feeMint: string;
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

export function isJupiterRateLimitError(error: unknown): boolean {
  if (error instanceof HttpError && error.status === 429) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /HTTP 429|Rate limit exceeded/i.test(msg);
}

function markRateLimited(): void {
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

function underRateLimitCooldown(): boolean {
  return Date.now() < rateLimitedUntil;
}

function headers(): Record<string, string> {
  const base: Record<string, string> = { accept: 'application/json' };
  if (env.JUPITER_API_KEY) base['x-api-key'] = env.JUPITER_API_KEY;
  return base;
}

/** Primary bases — Pro when keyed, else Lite. */
function primaryBases(): string[] {
  return env.JUPITER_API_KEY ? [env.JUPITER_API_BASE] : [LITE_BASE];
}

/** Lite only after a non-429 Pro failure (auth / outage), never after 429. */
function fallbackBases(): string[] {
  return env.JUPITER_API_KEY ? [LITE_BASE] : [];
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

async function quoteFromBase(
  base: string,
  params: QuoteParams,
  query: URLSearchParams,
  timeoutMs: number,
): Promise<QuoteResult> {
  const { data, latencyMs } = await withRetry(
    () =>
      fetchJson<JupiterQuote & { error?: string }>(
        `${base}/swap/v1/quote?${query.toString()}`,
        { headers: headers(), timeoutMs, label: 'jupiter/quote' },
      ),
    {
      attempts: 3,
      baseDelayMs: 80,
      maxDelayMs: 900,
      retryable: (error) => isJupiterRateLimitError(error) || error instanceof HttpError,
      onRetry: (error, attempt, delayMs) => {
        if (isJupiterRateLimitError(error)) markRateLimited();
        log.warn({ base, attempt, delayMs, err: error }, 'Jupiter quote retry');
      },
    },
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
}

export async function getJupiterQuote(
  params: QuoteParams,
  opts?: { urgency?: JupiterUrgency },
): Promise<QuoteResult> {
  const timeoutMs = jupiterHttpTimeoutMs(opts?.urgency ?? 'normal');
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountRaw,
    slippageBps: String(params.slippageBps),
    swapMode: params.swapMode ?? 'ExactIn',
  });
  if (params.onlyDirectRoutes) query.set('onlyDirectRoutes', 'true');

  if (underRateLimitCooldown()) {
    const waitMs = Math.min(RATE_LIMIT_COOLDOWN_MS, rateLimitedUntil - Date.now());
    if (waitMs > 0) await sleep(waitMs);
  }

  let lastError: unknown;
  for (const base of primaryBases()) {
    try {
      return await quoteFromBase(base, params, query, timeoutMs);
    } catch (error) {
      lastError = error;
      if (isJupiterRateLimitError(error)) {
        markRateLimited();
        // Do not fall through to Lite on 429 — that burns the same budget worse.
        log.warn({ base, err: error }, 'Jupiter Pro rate-limited; not falling back to Lite');
        throw error;
      }
      log.warn({ base, err: error }, 'Jupiter quote endpoint failed, trying fallback');
    }
  }

  for (const base of fallbackBases()) {
    try {
      return await quoteFromBase(base, params, query, timeoutMs);
    } catch (error) {
      lastError = error;
      if (isJupiterRateLimitError(error)) markRateLimited();
      log.warn({ base, err: error }, 'Jupiter Lite quote failed');
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
  /** Jupiter priorityLevelWithMaxLamports.priorityLevel */
  priorityLevel?: 'medium' | 'high' | 'veryHigh';
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
export async function buildJupiterSwap(
  params: SwapBuildParams,
  opts?: { urgency?: JupiterUrgency },
): Promise<SwapBuildResult> {
  const timeoutMs = jupiterHttpTimeoutMs(opts?.urgency ?? 'normal');
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: params.priorityFeeMicroLamports ?? env.SOLANA_MAX_PRIORITY_FEE_MICROLAMPORTS,
        priorityLevel: params.priorityLevel ?? 'high',
      },
    },
  };

  const tryBuild = async (base: string): Promise<SwapBuildResult> => {
    const { data, latencyMs } = await withRetry(
      () =>
        fetchJson<{
          swapTransaction: string;
          lastValidBlockHeight: number;
          prioritizationFeeLamports?: number;
          computeUnitLimit?: number;
          error?: string;
        }>(`${base}/swap/v1/swap`, {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs,
          label: 'jupiter/swap',
        }),
      {
        attempts: 2,
        baseDelayMs: 80,
        maxDelayMs: 800,
        retryable: (error) => isJupiterRateLimitError(error),
        onRetry: (error, attempt, delayMs) => {
          if (isJupiterRateLimitError(error)) markRateLimited();
          log.warn({ base, attempt, delayMs, err: error }, 'Jupiter swap retry');
        },
      },
    );

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
  };

  let lastError: unknown;
  for (const base of primaryBases()) {
    try {
      return await tryBuild(base);
    } catch (error) {
      lastError = error;
      if (isJupiterRateLimitError(error)) {
        markRateLimited();
        throw error;
      }
      log.warn({ base, err: error }, 'Jupiter swap build failed, trying fallback');
    }
  }
  for (const base of fallbackBases()) {
    try {
      return await tryBuild(base);
    } catch (error) {
      lastError = error;
      if (isJupiterRateLimitError(error)) markRateLimited();
      log.warn({ base, err: error }, 'Jupiter Lite swap build failed');
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

function readCachedPrices(
  mints: string[],
  maxAgeMs: number,
): { hit: Map<string, JupiterPrice>; miss: string[] } {
  const hit = new Map<string, JupiterPrice>();
  const miss: string[] = [];
  const now = Date.now();
  for (const mint of mints) {
    const cached = priceCache.get(mint);
    if (cached && now - cached.at < maxAgeMs) {
      hit.set(mint, cached.price);
    } else {
      miss.push(mint);
    }
  }
  return { hit, miss };
}

function storePrices(entries: Map<string, JupiterPrice>): void {
  const at = Date.now();
  for (const [mint, price] of entries) {
    priceCache.set(mint, { price, at });
  }
}

/** Test helper — clears in-memory price/rate-limit state. */
export function resetJupiterClientStateForTests(): void {
  priceCache.clear();
  rateLimitedUntil = 0;
}

/**
 * Live USD prices. `blockId` is retained because it proves which chain state
 * the price came from — important when reconciling a position mark.
 *
 * Cached for a few seconds so the exit monitor (250ms ticks) does not 429
 * Jupiter's price API and starve buy/sell quotes.
 */
export async function getJupiterPrices(mints: string[]): Promise<Map<string, JupiterPrice>> {
  const out = new Map<string, JupiterPrice>();
  if (mints.length === 0) return out;

  const unique = [...new Set(mints)];
  const fresh = readCachedPrices(unique, PRICE_CACHE_TTL_MS);
  for (const [mint, price] of fresh.hit) out.set(mint, price);

  let need = fresh.miss;
  if (need.length === 0) return out;

  // During a 429 cooldown, serve stale marks so SL still evaluates.
  if (underRateLimitCooldown()) {
    const stale = readCachedPrices(need, PRICE_STALE_OK_MS);
    for (const [mint, price] of stale.hit) out.set(mint, price);
    need = stale.miss;
    if (need.length === 0) {
      log.debug({ served: stale.hit.size }, 'Jupiter prices served from stale cache during 429 cooldown');
      return out;
    }
  }

  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50));

  for (const chunk of chunks) {
    let fetched = false;
    for (const base of [...primaryBases(), ...fallbackBases()]) {
      // On Pro 429, skip Lite for prices — use stale cache instead.
      if (base === LITE_BASE && underRateLimitCooldown() && env.JUPITER_API_KEY) {
        continue;
      }
      try {
        const { data } = await fetchJson<Record<string, JupiterPrice | null>>(
          `${base}/price/v3?ids=${chunk.join(',')}`,
          { headers: headers(), timeoutMs: 5_000, label: 'jupiter/price' },
        );
        const batch = new Map<string, JupiterPrice>();
        for (const [mint, price] of Object.entries(data)) {
          if (price && Number.isFinite(price.usdPrice) && price.usdPrice > 0) {
            batch.set(mint, price);
            out.set(mint, price);
          }
        }
        storePrices(batch);
        fetched = true;
        break;
      } catch (error) {
        if (isJupiterRateLimitError(error)) {
          markRateLimited();
          log.warn({ base, err: error }, 'Jupiter price rate-limited; using cache when available');
          // Prefer Pro retry later over Lite thrash.
          if (env.JUPITER_API_KEY && base !== LITE_BASE) break;
        } else {
          log.warn({ base, err: error }, 'Jupiter price endpoint failed');
        }
      }
    }
    if (!fetched) {
      const stale = readCachedPrices(chunk, PRICE_STALE_OK_MS);
      for (const [mint, price] of stale.hit) out.set(mint, price);
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
