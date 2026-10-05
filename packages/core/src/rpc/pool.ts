import type { Chain } from '@copyra/db';
import { componentLogger } from '../obs/logger.js';
import { safeEndpoint } from '../obs/redact.js';

const log = componentLogger('rpc-pool');

export interface EndpointState {
  url: string;
  /** Host only. Safe to log and to store in `rpc_health`. */
  safeUrl: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** Endpoint is skipped until this timestamp after repeated failure. */
  cooldownUntil: number;
}

export interface PoolOptions {
  chain: Chain;
  urls: string[];
  /** Failures before an endpoint is taken out of rotation. */
  failureThreshold?: number;
  cooldownMs?: number;
}

export class AllEndpointsFailedError extends Error {
  readonly code = 'ALL_RPC_ENDPOINTS_FAILED';
  readonly chain: Chain;
  readonly attempts: Array<{ endpoint: string; error: string }>;

  constructor(chain: Chain, attempts: Array<{ endpoint: string; error: string }>) {
    super(
      `All ${attempts.length} RPC endpoint(s) for ${chain} failed: ` +
        attempts.map((a) => `${a.endpoint} (${a.error})`).join('; '),
    );
    this.name = 'AllEndpointsFailedError';
    this.chain = chain;
    this.attempts = attempts;
  }
}

/**
 * Ordered RPC failover (spec §24).
 *
 * The first URL is the primary; later URLs are fallbacks tried in order. An
 * endpoint that fails `failureThreshold` times consecutively is put on cooldown
 * and skipped, which stops a dead provider from adding its timeout to the
 * critical path of every subsequent call. One success resets its counter.
 *
 * Fail-open by design: if every endpoint is on cooldown, cooldowns are ignored
 * and all are tried again rather than refusing to work.
 */
export class RpcPool<TClient> {
  readonly chain: Chain;
  readonly #states: EndpointState[];
  readonly #clients = new Map<string, TClient>();
  readonly #factory: (url: string) => TClient;
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;

  constructor(options: PoolOptions, factory: (url: string) => TClient) {
    const unique = [...new Set(options.urls.filter((u) => u && u.length > 0))];
    if (unique.length === 0) {
      throw new Error(`No RPC endpoints configured for ${options.chain}`);
    }
    this.chain = options.chain;
    this.#factory = factory;
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#states = unique.map((url) => ({
      url,
      safeUrl: safeEndpoint(url),
      healthy: true,
      consecutiveFailures: 0,
      lastLatencyMs: null,
      lastErrorAt: null,
      lastError: null,
      cooldownUntil: 0,
    }));
  }

  get size(): number {
    return this.#states.length;
  }

  /** Primary client without any failover. Used for subscriptions. */
  primary(): { client: TClient; url: string } {
    const state = this.#states[0] as EndpointState;
    return { client: this.#client(state.url), url: state.url };
  }

  health(): EndpointState[] {
    return this.#states.map((s) => ({ ...s }));
  }

  #client(url: string): TClient {
    let client = this.#clients.get(url);
    if (!client) {
      client = this.#factory(url);
      this.#clients.set(url, client);
    }
    return client;
  }

  #ordered(): EndpointState[] {
    const now = Date.now();
    const available = this.#states.filter((s) => s.cooldownUntil <= now);
    // Fail-open: never return an empty candidate list.
    return available.length > 0 ? available : this.#states;
  }

  /**
   * Runs `fn` against endpoints in order until one succeeds. Returns the
   * result plus which endpoint served it and how long it took, so callers can
   * attach real RPC latency to telemetry.
   */
  async call<T>(
    label: string,
    fn: (client: TClient, url: string) => Promise<T>,
  ): Promise<{ value: T; endpoint: string; latencyMs: number }> {
    const attempts: Array<{ endpoint: string; error: string }> = [];

    for (const state of this.#ordered()) {
      const startedAt = Date.now();
      try {
        const value = await fn(this.#client(state.url), state.url);
        const latencyMs = Date.now() - startedAt;
        state.healthy = true;
        state.consecutiveFailures = 0;
        state.lastLatencyMs = latencyMs;
        state.cooldownUntil = 0;
        return { value, endpoint: state.safeUrl, latencyMs };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.consecutiveFailures += 1;
        state.lastError = message;
        state.lastErrorAt = Date.now();
        if (state.consecutiveFailures >= this.#failureThreshold) {
          state.healthy = false;
          state.cooldownUntil = Date.now() + this.#cooldownMs;
          log.warn(
            { chain: this.chain, endpoint: state.safeUrl, failures: state.consecutiveFailures, label },
            'RPC endpoint taken out of rotation',
          );
        }
        attempts.push({ endpoint: state.safeUrl, error: message });
      }
    }

    log.error({ chain: this.chain, label, attempts }, 'All RPC endpoints failed');
    throw new AllEndpointsFailedError(this.chain, attempts);
  }
}
