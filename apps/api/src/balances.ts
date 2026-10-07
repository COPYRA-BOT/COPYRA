import {
  getSolanaBalances,
  getTradingAvailableQuote,
  multiUserCustodyEnabled,
  tradingWalletAddress,
  userCustodyAddress,
} from '@copyra/core';
import { Chain } from '@copyra/db';

/** Chains shown on the Solana dashboard. */
const SOL_CHAINS = [Chain.SOLANA] as const;
/** Chains shown on the EVM dashboard (USDC + native gas). */
const EVM_CHAINS = [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC] as const;

type WalletEntry = Record<string, unknown>;

const BALANCE_RPC_TIMEOUT_MS = 4_000;

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

/**
 * Mode-scoped wallet balance entry.
 *
 * When multi-user custody is on and a userId is present, this NEVER returns the
 * shared bot signer — only that account's custody address. RPC failures still
 * return the custody address so the UI can stay sticky instead of flipping to
 * the empty bot wallet (which caused “balance disappeared” + ExQW… confusion).
 */
async function walletEntry(chain: Chain, userId: string | undefined): Promise<WalletEntry> {
  const multi = multiUserCustodyEnabled();

  // Signed-out / no session for this mode: do not leak the shared bot wallet
  // into the dashboard as if it were the user's balance.
  if (multi && !userId) {
    return {
      chain,
      configured: false,
      address: null,
      userScoped: true,
      role: 'custody',
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
      address = await userCustodyAddress(userId, chain);
    } catch (error) {
      return {
        chain,
        configured: false,
        address: null,
        userScoped: true,
        role: 'custody',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return withTimeout(
      (async () => {
        try {
          const funds = await getTradingAvailableQuote(chain, userId);
          if (chain === Chain.SOLANA) {
            const balances = await getSolanaBalances(address);
            return {
              chain,
              configured: true,
              address,
              userScoped: true,
              role: 'custody',
              nativeRaw: balances.lamports.toString(),
              native: funds.onChainQuote,
              available: funds.availableQuote,
              withdrawable: funds.withdrawableQuote,
              gasReserve: funds.gasReserveQuote,
              onChainNative: funds.onChainQuote,
              savings: funds.savingsQuote,
              assetSymbol: funds.assetSymbol,
              assetDecimals: funds.assetDecimals,
              tokens: balances.tokens,
              slot: balances.slot.toString(),
              source: 'rpc',
            };
          }
          return {
            chain,
            configured: true,
            address,
            userScoped: true,
            role: 'custody',
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
        } catch (error) {
          // Keep custody address so the UI never falls back to the bot signer.
          return {
            chain,
            configured: true,
            address,
            userScoped: true,
            role: 'custody',
            error: error instanceof Error ? error.message : String(error),
            native: null,
            available: null,
            onChainNative: null,
            savings: null,
          };
        }
      })(),
      BALANCE_RPC_TIMEOUT_MS,
      () => ({
        chain,
        configured: true,
        address,
        userScoped: true,
        role: 'custody',
        error: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms`,
        native: null,
        available: null,
        onChainNative: null,
        savings: null,
      }),
    );
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
  try {
    const funds = await getTradingAvailableQuote(chain);
    if (chain === Chain.SOLANA) {
      const balances = await getSolanaBalances(address);
      return {
        chain,
        configured: true,
        address,
        role: 'bot',
        nativeRaw: balances.lamports.toString(),
        native: funds.onChainQuote,
        available: funds.availableQuote,
        withdrawable: funds.withdrawableQuote,
        gasReserve: funds.gasReserveQuote,
        onChainNative: funds.onChainQuote,
        savings: funds.savingsQuote,
        assetSymbol: funds.assetSymbol,
        assetDecimals: funds.assetDecimals,
        tokens: balances.tokens,
        slot: balances.slot.toString(),
        source: 'rpc',
      };
    }
    return {
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
  } catch (error) {
    return {
      chain,
      configured: true,
      address,
      role: 'bot',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build balances for one mode using that mode's userId.
 * SOL and EVM are independent accounts — never mix userIds across modes.
 */
export async function buildModeBalances(
  mode: 'sol' | 'evm',
  userId?: string,
): Promise<{
  mode: 'sol' | 'evm';
  userId: string | null;
  wallets: WalletEntry[];
  multiUserCustody: boolean;
  custodyAddress: string | null;
}> {
  const chains = mode === 'sol' ? SOL_CHAINS : EVM_CHAINS;
  // Parallel RPC per chain — EVM was sequential and one slow/dead RPC zeroed the UI.
  const wallets = await Promise.all(chains.map((chain) => walletEntry(chain, userId)));
  const custodyAddress =
    (wallets.find((w) => w.userScoped && typeof w.address === 'string')?.address as string | undefined) ??
    null;
  return {
    mode,
    userId: userId ?? null,
    wallets,
    multiUserCustody: multiUserCustodyEnabled(),
    custodyAddress,
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

/**
 * Shared worker/bot signer balances (informational).
 * Copy trades size from per-user custody — these funds are NOT the Trading Balance
 * unless MULTI_USER_CUSTODY is off. Surfaced so deposits to the worker key are visible.
 */
export async function buildWorkerWalletBalances(): Promise<{
  role: 'worker';
  solana: WalletEntry | null;
  evm: WalletEntry[];
}> {
  const readBot = async (chain: Chain): Promise<WalletEntry> => {
    const address = tradingWalletAddress(chain);
    if (!address) {
      return { chain, configured: false, address: null, role: 'worker' };
    }
    return withTimeout(
      (async () => {
        try {
          const funds = await getTradingAvailableQuote(chain);
          return {
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
        } catch (error) {
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
      () => ({
        chain,
        configured: true,
        address,
        role: 'worker',
        error: `rpc-timeout>${BALANCE_RPC_TIMEOUT_MS}ms`,
        native: null,
        available: null,
        onChainNative: null,
      }),
    );
  };

  const [solana, ...evm] = await Promise.all([
    readBot(Chain.SOLANA),
    ...EVM_CHAINS.map((c) => readBot(c)),
  ]);
  return { role: 'worker', solana, evm };
}
