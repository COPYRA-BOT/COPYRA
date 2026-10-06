import {
  getSolanaBalances,
  getTradingAvailableQuote,
  multiUserCustodyEnabled,
  tradingWalletAddress,
} from '@copyra/core';
import { Chain } from '@copyra/db';

/** All chains the dashboard can show live trading balances for. */
const BALANCE_CHAINS = [Chain.SOLANA, Chain.BASE, Chain.ARBITRUM, Chain.BSC] as const;

export async function buildBalancesResponse(userId?: string): Promise<{
  wallets: Array<Record<string, unknown>>;
  multiUserCustody: boolean;
}> {
  const wallets: Array<Record<string, unknown>> = [];

  for (const chain of BALANCE_CHAINS) {
    if (multiUserCustodyEnabled() && userId) {
      try {
        const funds = await getTradingAvailableQuote(chain, userId);
        if (!funds.address) {
          wallets.push({ chain, configured: false, address: null, userScoped: true });
          continue;
        }
        if (chain === Chain.SOLANA) {
          const balances = await getSolanaBalances(funds.address);
          wallets.push({
            chain,
            configured: funds.configured,
            address: funds.address,
            userScoped: true,
            nativeRaw: balances.lamports.toString(),
            native: funds.availableQuote,
            onChainNative: funds.onChainQuote,
            savings: funds.savingsQuote,
            assetSymbol: funds.assetSymbol,
            assetDecimals: funds.assetDecimals,
            tokens: balances.tokens,
            slot: balances.slot.toString(),
            source: 'rpc',
          });
        } else {
          wallets.push({
            chain,
            configured: funds.configured,
            address: funds.address,
            userScoped: true,
            native: funds.availableQuote,
            onChainNative: funds.onChainQuote,
            savings: funds.savingsQuote,
            assetSymbol: funds.assetSymbol,
            assetDecimals: funds.assetDecimals,
            source: 'rpc',
          });
        }
      } catch (error) {
        wallets.push({
          chain,
          configured: false,
          userScoped: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const address = tradingWalletAddress(chain);
    if (!address) {
      wallets.push({
        chain,
        configured: false,
        address: null,
        detail: 'No bot signing key configured.',
      });
      continue;
    }
    try {
      const funds = await getTradingAvailableQuote(chain);
      if (chain === Chain.SOLANA) {
        const balances = await getSolanaBalances(address);
        wallets.push({
          chain,
          configured: true,
          address,
          nativeRaw: balances.lamports.toString(),
          native: funds.availableQuote,
          onChainNative: funds.onChainQuote,
          savings: funds.savingsQuote,
          assetSymbol: funds.assetSymbol,
          assetDecimals: funds.assetDecimals,
          tokens: balances.tokens,
          slot: balances.slot.toString(),
          source: 'rpc',
        });
      } else {
        wallets.push({
          chain,
          configured: true,
          address,
          native: funds.availableQuote,
          onChainNative: funds.onChainQuote,
          savings: funds.savingsQuote,
          assetSymbol: funds.assetSymbol,
          assetDecimals: funds.assetDecimals,
          source: 'rpc',
        });
      }
    } catch (error) {
      wallets.push({
        chain,
        configured: true,
        address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { wallets, multiUserCustody: multiUserCustodyEnabled() };
}
