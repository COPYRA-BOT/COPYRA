import {
  getSolanaBalances,
  getTradingAvailableQuote,
  multiUserCustodyEnabled,
  tradingWalletAddress,
} from '@copyra/core';
import { Chain } from '@copyra/db';

/** Chains shown on the Solana dashboard. */
const SOL_CHAINS = [Chain.SOLANA] as const;
/** Chains shown on the EVM dashboard (USDC + native gas). */
const EVM_CHAINS = [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC] as const;

async function walletEntry(
  chain: Chain,
  userId: string | undefined,
): Promise<Record<string, unknown>> {
  if (multiUserCustodyEnabled() && userId) {
    try {
      const funds = await getTradingAvailableQuote(chain, userId);
      if (!funds.address) {
        return { chain, configured: false, address: null, userScoped: true };
      }
      if (chain === Chain.SOLANA) {
        const balances = await getSolanaBalances(funds.address);
        return {
          chain,
          configured: funds.configured,
          address: funds.address,
          userScoped: true,
          nativeRaw: balances.lamports.toString(),
          // Headline balance = real on-chain amount (not fee-buffered available).
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
        configured: funds.configured,
        address: funds.address,
        userScoped: true,
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
        configured: false,
        userScoped: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const address = tradingWalletAddress(chain);
  if (!address) {
    return {
      chain,
      configured: false,
      address: null,
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
  wallets: Array<Record<string, unknown>>;
  multiUserCustody: boolean;
}> {
  const chains = mode === 'sol' ? SOL_CHAINS : EVM_CHAINS;
  const wallets: Array<Record<string, unknown>> = [];
  for (const chain of chains) {
    wallets.push(await walletEntry(chain, userId));
  }
  return {
    mode,
    userId: userId ?? null,
    wallets,
    multiUserCustody: multiUserCustodyEnabled(),
  };
}

/** @deprecated Prefer buildModeBalances — kept for any single-user callers. */
export async function buildBalancesResponse(userId?: string): Promise<{
  wallets: Array<Record<string, unknown>>;
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
