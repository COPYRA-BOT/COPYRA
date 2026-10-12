import {
  getTradingAvailableQuote,
  multiUserCustodyEnabled,
  tradingWalletAddress,
  userCustodyAddress,
} from '@copyra/core';
import { Chain, CustodyFamily } from '@copyra/db';

/** Chains shown on the Solana dashboard. */
const SOL_CHAINS = [Chain.SOLANA] as const;
/** Chains shown on the EVM dashboard (USDC + native gas). */
const EVM_CHAINS = [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC] as const;

type WalletEntry = Record<string, unknown>;

const BALANCE_RPC_TIMEOUT_MS = 6_000;
/** Serve immediately without waiting on RPC. */
const BAL_CACHE_FRESH_MS = 8_000;
/** Keep last confirmed custody read across blips (never invent; only replay prior success). */
const BAL_CACHE_STALE_MS = 60 * 60_000;

type CacheRow = { at: number; entry: WalletEntry };
const balanceCache = new Map<string, CacheRow>();
const refreshInflight = new Map<string, Promise<void>>();
let workerCache: { at: number; value: Awaited<ReturnType<typeof fetchWorkerWalletBalances>> } | null =
  null;
const WORKER_CACHE_MS = 60_000;

function cacheKey(chain: Chain, address: string, family?: CustodyFamily | null): string {
  const fam = family ? `:${family}` : '';
  return `${chain}${fam}:${address.toLowerCase()}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
          void error;
        }
      });
  });
}

function rememberSuccess(entry: WalletEntry): void {
  const address = typeof entry.address === 'string' ? entry.address : null;
  const chain = entry.chain as Chain | undefined;
  if (!address || !chain) return;
  if (typeof entry.onChainNative !== 'number' && typeof entry.native !== 'number') return;
  const family = (entry.family as CustodyFamily | null | undefined) ?? null;
  balanceCache.set(cacheKey(chain, address, family), {
    at: Date.now(),
    entry: { ...entry, source: 'rpc' },
  });
}

function staleGood(
  chain: Chain,
  address: string,
  family?: CustodyFamily | null,
): WalletEntry | null {
  const hit = balanceCache.get(cacheKey(chain, address, family));
  if (!hit) return null;
  if (Date.now() - hit.at > BAL_CACHE_STALE_MS) return null;
  return {
    ...hit.entry,
    source: Date.now() - hit.at <= BAL_CACHE_FRESH_MS ? 'rpc' : 'rpc-cache',
    cachedAt: new Date(hit.at).toISOString(),
  };
}

async function fetchCustodyFunds(
  chain: Chain,
  userId: string,
  address: string,
  opts?: { family?: CustodyFamily },
): Promise<WalletEntry> {
  const family = opts?.family ?? null;
  return withTimeout(
    (async () => {
      try {
        const funds = await getTradingAvailableQuote(chain, userId, opts);
        const entry: WalletEntry = {
          chain,
          configured: true,
          address,
          userScoped: true,
          role: 'custody',
          family,
          native: funds.onChainQuote,
          available: funds.availableQuote,
          withdrawable: funds.withdrawableQuote,
          gasReserve: funds.gasReserveQuote,
          onChainNative: funds.onChainQuote,
          savings: funds.savingsQuote,
          assetSymbol: funds.assetSymbol,
          assetDecimals: funds.assetDecimals,
          source: 'rpc',
        };
        rememberSuccess(entry);
        return entry;
      } catch (error) {
        const cached = staleGood(chain, address, family);
        if (cached) {
          return { ...cached, staleError: error instanceof Error ? error.message : String(error) };
        }
        return {
          chain,
          configured: true,
          address,
          userScoped: true,
          role: 'custody',
          family,
          error: error instanceof Error ? error.message : String(error),
          native: null,
          available: null,
          onChainNative: null,
          savings: null,
        };
      }
    })(),
    BALANCE_RPC_TIMEOUT_MS,
    () => {
      const cached = staleGood(chain, address, family);
      if (cached) return { ...cached, staleError: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms` };
      return {
        chain,
        configured: true,
        address,
        userScoped: true,
        role: 'custody',
        family,
        error: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms`,
        native: null,
        available: null,
        onChainNative: null,
        savings: null,
      };
    },
  );
}

function kickCustodyRefresh(
  chain: Chain,
  userId: string,
  address: string,
  opts?: { family?: CustodyFamily },
): void {
  const key = cacheKey(chain, address, opts?.family);
  if (refreshInflight.has(key)) return;
  const work = fetchCustodyFunds(chain, userId, address, opts)
    .then(() => undefined)
    .finally(() => {
      refreshInflight.delete(key);
    });
  refreshInflight.set(key, work);
}

/**
 * Stale-while-revalidate: return last confirmed custody balance immediately,
 * refresh RPC in the background. Only waits on RPC when there is no cache yet.
 */
async function readCustodyFunds(
  chain: Chain,
  userId: string,
  address: string,
  opts?: { family?: CustodyFamily },
): Promise<WalletEntry> {
  const family = opts?.family ?? null;
  const hit = balanceCache.get(cacheKey(chain, address, family));
  const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY;

  if (hit && age < BAL_CACHE_FRESH_MS) {
    return { ...hit.entry, source: 'rpc-cache', cachedAt: new Date(hit.at).toISOString() };
  }

  if (hit && age < BAL_CACHE_STALE_MS) {
    kickCustodyRefresh(chain, userId, address, opts);
    return {
      ...hit.entry,
      source: 'rpc-cache',
      cachedAt: new Date(hit.at).toISOString(),
    };
  }

  return fetchCustodyFunds(chain, userId, address, opts);
}

/**
 * Mode-scoped wallet balance entry.
 *
 * When multi-user custody is on and a userId is present, this NEVER returns the
 * shared bot signer — only that account's custody address. On RPC failure, the
 * last successful RPC read for that custody address is returned (stale cache)
 * so buckets do not disappear while the wallet still has funds.
 */
async function walletEntry(
  chain: Chain,
  userId: string | undefined,
  opts?: { family?: CustodyFamily },
): Promise<WalletEntry> {
  const multi = multiUserCustodyEnabled();

  if (multi && !userId) {
    return {
      chain,
      configured: false,
      address: null,
      userScoped: true,
      role: 'custody',
      family: opts?.family ?? null,
      needsAuth: true,
      native: null,
      available: null,
      onChainNative: null,
      savings: null,
    };
  }

  if (multi && userId) {
    let address: string | null = null;
    try {
      address = await userCustodyAddress(
        userId,
        chain,
        opts?.family ? { family: opts.family } : undefined,
      );
    } catch (error) {
      return {
        chain,
        configured: false,
        address: null,
        userScoped: true,
        role: 'custody',
        family: opts?.family ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return readCustodyFunds(chain, userId, address, opts);
  }

  // Legacy single-bot mode (MULTI_USER_CUSTODY=false only).
  const address = tradingWalletAddress(chain);
  if (!address) {
    return {
      chain,
      configured: false,
      address: null,
      role: 'bot',
      detail: 'No bot signing key configured.',
    };
  }
  return withTimeout(
    (async () => {
      try {
        const funds = await getTradingAvailableQuote(chain);
        const entry: WalletEntry = {
          chain,
          configured: true,
          address,
          role: 'bot',
          native: funds.onChainQuote,
          available: funds.availableQuote,
          withdrawable: funds.withdrawableQuote,
          gasReserve: funds.gasReserveQuote,
          onChainNative: funds.onChainQuote,
          savings: funds.savingsQuote,
          assetSymbol: funds.assetSymbol,
          assetDecimals: funds.assetDecimals,
          source: 'rpc',
        };
        rememberSuccess(entry);
        return entry;
      } catch (error) {
        const cached = staleGood(chain, address);
        if (cached) return { ...cached, role: 'bot', staleError: error instanceof Error ? error.message : String(error) };
        return {
          chain,
          configured: true,
          address,
          role: 'bot',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })(),
    BALANCE_RPC_TIMEOUT_MS,
    () => {
      const cached = staleGood(chain, address);
      if (cached) return { ...cached, role: 'bot', staleError: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms` };
      return {
        chain,
        configured: true,
        address,
        role: 'bot',
        error: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms`,
      };
    },
  );
}

/**
 * Build balances for one mode using that mode's userId.
 * SOL / EVM / SNIPER are independent spenders — never mix custody families.
 */
export async function buildModeBalances(
  mode: 'sol' | 'evm' | 'sniper',
  userId?: string,
): Promise<{
  mode: 'sol' | 'evm' | 'sniper';
  userId: string | null;
  wallets: WalletEntry[];
  multiUserCustody: boolean;
  custodyAddress: string | null;
  family: CustodyFamily | null;
}> {
  const chains = mode === 'evm' ? EVM_CHAINS : SOL_CHAINS;
  const family =
    mode === 'sniper'
      ? CustodyFamily.SNIPER
      : mode === 'sol'
        ? CustodyFamily.SOLANA
        : undefined;
  const wallets = await Promise.all(
    chains.map((chain) => walletEntry(chain, userId, family ? { family } : undefined)),
  );
  let custodyAddress =
    (wallets.find((w) => w.userScoped && typeof w.address === 'string')?.address as string | undefined) ??
    null;

  // Hard isolation: sniper custody must never resolve to the SOL copy address.
  if (mode === 'sniper' && userId && custodyAddress) {
    try {
      const solAddr = await userCustodyAddress(userId, Chain.SOLANA, {
        family: CustodyFamily.SOLANA,
      });
      if (solAddr && custodyAddress === solAddr) {
        custodyAddress = null;
        for (const w of wallets) {
          w.address = null;
          w.native = 0;
          w.available = 0;
          w.onChainNative = 0;
          w.savings = 0;
          w.error = 'sniper-custody-collided-with-sol — refusing to paint SOL balance';
        }
      }
    } catch {
      /* keep sniper wallets as-is when SOL address lookup fails */
    }
  }

  return {
    mode,
    userId: userId ?? null,
    wallets,
    multiUserCustody: multiUserCustodyEnabled(),
    custodyAddress,
    family: family ?? null,
  };
}

/** @deprecated Prefer buildModeBalances — kept for any single-user callers. */
export async function buildBalancesResponse(userId?: string): Promise<{
  wallets: WalletEntry[];
  multiUserCustody: boolean;
}> {
  const [sol, evm] = await Promise.all([
    buildModeBalances('sol', userId),
    buildModeBalances('evm', userId),
  ]);
  return {
    wallets: [...sol.wallets, ...evm.wallets],
    multiUserCustody: multiUserCustodyEnabled(),
  };
}

async function fetchWorkerWalletBalances(): Promise<{
  role: 'worker';
  solana: WalletEntry | null;
  evm: WalletEntry[];
}> {
  const readBot = async (chain: Chain): Promise<WalletEntry> => {
    const address = tradingWalletAddress(chain);
    if (!address) {
      return { chain, configured: false, address: null, role: 'worker' };
    }
    const cached = staleGood(chain, address);
    if (cached && Date.now() - (balanceCache.get(cacheKey(chain, address))?.at ?? 0) < BAL_CACHE_FRESH_MS) {
      return { ...cached, role: 'worker' };
    }
    return withTimeout(
      (async () => {
        try {
          const funds = await getTradingAvailableQuote(chain);
          const entry: WalletEntry = {
            chain,
            configured: true,
            address,
            role: 'worker',
            native: funds.onChainQuote,
            available: funds.availableQuote,
            onChainNative: funds.onChainQuote,
            savings: funds.savingsQuote,
            assetSymbol: funds.assetSymbol,
            assetDecimals: funds.assetDecimals,
            source: 'rpc',
          };
          rememberSuccess(entry);
          return entry;
        } catch (error) {
          if (cached) return { ...cached, role: 'worker' };
          return {
            chain,
            configured: true,
            address,
            role: 'worker',
            error: error instanceof Error ? error.message : String(error),
            native: null,
            available: null,
            onChainNative: null,
          };
        }
      })(),
      BALANCE_RPC_TIMEOUT_MS,
      () =>
        cached
          ? { ...cached, role: 'worker' }
          : {
              chain,
              configured: true,
              address,
              role: 'worker',
              error: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms`,
              native: null,
              available: null,
              onChainNative: null,
            },
    );
  };

  const [solana, ...evm] = await Promise.all([
    readBot(Chain.SOLANA),
    ...EVM_CHAINS.map((c) => readBot(c)),
  ]);
  return { role: 'worker', solana, evm };
}

/**
 * Shared worker/bot signer balances (informational, cached).
 * Copy trades size from per-user custody — these funds are NOT the Trading Balance
 * unless MULTI_USER_CUSTODY is off.
 */
export async function buildWorkerWalletBalances(): Promise<{
  role: 'worker';
  solana: WalletEntry | null;
  evm: WalletEntry[];
}> {
  if (workerCache && Date.now() - workerCache.at < WORKER_CACHE_MS) {
    return workerCache.value;
  }
  const value = await fetchWorkerWalletBalances();
  workerCache = { at: Date.now(), value };
  return value;
}
