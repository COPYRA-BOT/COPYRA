import { Chain, ExitStrategy, SkipReason, TradeReason } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { renderBuy, renderFailure, renderSell, renderSkip } from './messages.js';

const exitConfig = {
  takeProfitPct: 20,
  stopLossPct: 10,
  trailingDropPct: 15,
  trailingPartialSellPct: 50,
};

describe('renderBuy', () => {
  it('matches the spec BUY layout, including chain, MC, exit plan and explorer', () => {
    const text = renderBuy({
      chain: Chain.SOLANA,
      tokenSymbol: 'BONK',
      tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      marketCapUsd: 4_200_000,
      liquidityUsd: 310_000,
      traderLabel: 'Whale1',
      traderAddress: '7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123fQ',
      spentQuote: 1.25,
      spentUsd: 294,
      balanceSharePct: 50,
      executionPriceUsd: 0.0000231,
      requestedSlippageBps: 100,
      realizedSlippagePct: null,
      priceImpactPct: 0.4,
      feeNative: 0.0004,
      speedMs: 1800,
      exitStrategy: ExitStrategy.MANUAL,
      exitConfig,
      balanceQuote: 4.8,
      balanceUsd: 1128,
      openPnlQuote: 0,
      txHash: '5QQ4cZKfWxXaZ959UULnHbsLhRZikm7Ar8WpqSVRmoXdr1CQTT5dYHH3f9JEy8D84k1eSZNHWzdMkXMqxyLzCyLn',
    });

    expect(text).toContain('🟢 <b>BUY · SOL</b>');
    expect(text).toContain('$BONK · MC $4.2M · Liq $310K');
    expect(text).toContain('Trader: Whale1 (7xKp…3fQ)');
    expect(text).toContain('Spent: 1.25 SOL ($294) · 50%');
    expect(text).toContain('Price: $0.0000231');
    expect(text).toContain('Impact 0.40%');
    expect(text).toContain('Exit plan: TP +20% · SL -10%');
    expect(text).toContain('Open P&amp;L:');
    expect(text).toContain('solscan.io/tx/5QQ4cZKfWxXaZ959UULnHbsLhRZikm7Ar8WpqSVRmoXdr1CQTT5dYHH3f9JEy8D84k1eSZNHWzdMkXMqxyLzCyLn');
    expect(text).toContain('Solscan');
  });

  it('renders Trailing in the exit-plan line for Option B', () => {
    const text = renderBuy({
      chain: Chain.BASE,
      tokenSymbol: 'TEST',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      marketCapUsd: 2_000_000,
      liquidityUsd: 80_000,
      traderLabel: 'T',
      traderAddress: '0x1111111111111111111111111111111111111111',
      spentQuote: 0.01,
      spentUsd: 3,
      balanceSharePct: null,
      executionPriceUsd: 1,
      requestedSlippageBps: 50,
      realizedSlippagePct: null,
      priceImpactPct: 0.1,
      feeNative: 0.0001,
      speedMs: null,
      exitStrategy: ExitStrategy.TRAILING,
      exitConfig,
      balanceQuote: 0.1,
      balanceUsd: 30,
      openPnlQuote: 0,
      txHash: '0xabc',
    });
    expect(text).toContain('BUY · BASE');
    expect(text).toContain('Trailing 15%');
    expect(text).toContain('Speed: not measured');
    expect(text).toContain('basescan.org/tx/0xabc');
  });
});

describe('renderSell', () => {
  it('titles STOP LOSS / TAKE PROFIT / TRAILING STOP / TRADER SOLD from the reason', () => {
    const base = {
      chain: Chain.SOLANA,
      tokenSymbol: 'BONK',
      marketCapUsd: 4_100_000,
      liquidityUsd: 305_000,
      traderLabel: 'Whale1',
      traderAddress: '7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123fQ',
      entryPriceUsd: 0.0000231,
      exitPriceUsd: 0.0000208,
      entryQuote: 1.25,
      exitQuote: 1.12,
      feeNative: 0.0004,
      speedMs: 2100,
      heldMs: 7 * 60_000 + 12_000,
      pnlQuote: -0.13,
      pnlPct: -10.4,
      balanceQuote: 4.67,
      balanceUsd: 1098,
      totalPnlQuote: -0.13,
      txHash: 'SigSell111',
    };

    const sl = renderSell({ ...base, reason: TradeReason.STOP_LOSS });
    expect(sl).toContain('SELL · STOP LOSS · SOL');
    expect(sl).toContain('LOSS:');
    expect(sl).toContain('Held: 7m 12s');

    const tp = renderSell({
      ...base,
      reason: TradeReason.TAKE_PROFIT,
      pnlQuote: 0.26,
      pnlPct: 20.8,
      exitQuote: 1.51,
    });
    expect(tp).toContain('SELL · TAKE PROFIT · SOL');
    expect(tp).toContain('PROFIT:');

    expect(renderSell({ ...base, reason: TradeReason.TRAILING_STOP })).toContain('TRAILING STOP');
    expect(renderSell({ ...base, reason: TradeReason.TRADER_SOLD })).toContain('TRADER SOLD');
  });
});

describe('renderSkip / renderFailure', () => {
  it('states the skip reason instead of implying a trade happened', () => {
    const text = renderSkip({
      chain: Chain.SOLANA,
      tokenSymbol: 'BONK',
      tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      traderLabel: 'Whale1',
      traderAddress: '7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123fQ',
      reason: SkipReason.NOT_FIRST_BUY,
      detail: 'Already copied.',
      marketCapUsd: 4_200_000,
      liquidityUsd: 310_000,
      sourceTxHash: 'TraderSig',
    });
    expect(text).toContain('SKIPPED · SOL');
    expect(text).toContain('NOT_FIRST_BUY');
    expect(text).toContain('solscan.io/tx/TraderSig');
  });

  it('says no funds moved when a failure has no transaction hash', () => {
    const text = renderFailure({
      chain: Chain.BASE,
      side: 'BUY',
      tokenSymbol: 'TEST',
      errorCode: 'NO_SIGNER',
      errorMessage: 'No EVM signing key is configured.',
      txHash: null,
      attempts: 1,
    });
    expect(text).toContain('BUY FAILED · BASE');
    expect(text).toContain('No transaction was broadcast. No funds moved.');
  });
});
