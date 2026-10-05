import { ExitStrategy } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import {
  computeExitLevels,
  computeTrailingStop,
  describeExitPlan,
  evaluateExit,
  updateHighWaterMark,
} from './exits.js';
import { strategyConfig } from './__tests__/fixtures.js';

const config = strategyConfig();

describe('computeExitLevels', () => {
  it('uses entry × 0.90 for SL and entry × 1.20 for TP', () => {
    const levels = computeExitLevels(1, config);
    expect(levels.stopLossPriceUsd).toBeCloseTo(0.9, 10);
    expect(levels.takeProfitPriceUsd).toBeCloseTo(1.2, 10);
    expect(levels.trailingTriggerPriceUsd).toBeCloseTo(1.2, 10);
  });
});

describe('evaluateExit — Option A (MANUAL)', () => {
  it('holds between the bands', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 1.05,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: false,
    });
    expect(action.action).toBe('HOLD');
  });

  it('sells 100% at +20% take profit', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 1.2,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: false,
    });
    expect(action).toMatchObject({ action: 'SELL', fraction: 1, reason: 'TAKE_PROFIT' });
  });

  it('sells 100% at −10% stop loss', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 0.9,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: false,
    });
    expect(action).toMatchObject({ action: 'SELL', fraction: 1, reason: 'STOP_LOSS' });
  });

  it('prefers stop loss over take profit when both would fire (unusable but defensive)', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 0.5,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: true,
    });
    expect(action).toMatchObject({ action: 'SELL', reason: 'STOP_LOSS' });
  });
});

describe('evaluateExit — Option B (TRAILING)', () => {
  it('sells 50% at +20% and arms the trailing stop', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.TRAILING,
      entryPriceUsd: 1,
      currentPriceUsd: 1.25,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: false,
    });
    expect(action).toMatchObject({ action: 'ACTIVATE_TRAILING', fraction: 0.5 });
  });

  it('does not re-fire the partial sell once it has executed', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.TRAILING,
      entryPriceUsd: 1,
      currentPriceUsd: 1.4,
      highestPriceUsd: 1.4,
      trailingActive: true,
      partialTakeProfitDone: true,
      traderSold: false,
    });
    expect(action.action).toBe('HOLD');
  });

  it('sells the remainder when price falls 15% off the high', () => {
    // High $2.00 → trailing stop $1.70. Current $1.70.
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.TRAILING,
      entryPriceUsd: 1,
      currentPriceUsd: 1.7,
      highestPriceUsd: 2,
      trailingActive: true,
      partialTakeProfitDone: true,
      traderSold: false,
    });
    expect(action).toMatchObject({ action: 'SELL', fraction: 1, reason: 'TRAILING_STOP' });
  });

  it('still honours the hard stop loss after trailing is armed', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.TRAILING,
      entryPriceUsd: 1,
      currentPriceUsd: 0.85,
      highestPriceUsd: 1.5,
      trailingActive: true,
      partialTakeProfitDone: true,
      traderSold: false,
    });
    expect(action).toMatchObject({ action: 'SELL', reason: 'STOP_LOSS' });
  });
});

describe('evaluateExit — trader sold', () => {
  it('mirrors a trader sell when followTraderSells is on', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 1.05,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: true,
    });
    expect(action).toMatchObject({ action: 'SELL', fraction: 1, reason: 'TRADER_SOLD' });
  });

  it('ignores a trader sell when followTraderSells is off', () => {
    const action = evaluateExit({
      config: strategyConfig({ followTraderSells: false }),
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 1.05,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: true,
    });
    expect(action.action).toBe('HOLD');
  });
});

describe('updateHighWaterMark', () => {
  it('does not track highs before trailing is armed', () => {
    expect(updateHighWaterMark(null, 9, false)).toBeNull();
  });

  it('tracks the highest confirmed price after trailing activates', () => {
    expect(updateHighWaterMark(null, 1.3, true)).toBe(1.3);
    expect(updateHighWaterMark(1.3, 1.5, true)).toBe(1.5);
    expect(updateHighWaterMark(1.5, 1.4, true)).toBe(1.5);
  });
});

describe('computeTrailingStop + describeExitPlan', () => {
  it('is highest × 0.85 at the default 15% drop', () => {
    expect(computeTrailingStop(2, 15)).toBeCloseTo(1.7, 10);
  });

  it('renders the spec exit-plan strings', () => {
    expect(describeExitPlan(ExitStrategy.MANUAL, config)).toBe('TP +20% · SL -10%');
    expect(describeExitPlan(ExitStrategy.TRAILING, config)).toBe(
      'TP +20% (50%) · Trailing 15% · SL -10%',
    );
  });
});

describe('evaluateExit — bad input', () => {
  it('holds rather than acting on a zero price', () => {
    const action = evaluateExit({
      config,
      exitStrategy: ExitStrategy.MANUAL,
      entryPriceUsd: 1,
      currentPriceUsd: 0,
      highestPriceUsd: null,
      trailingActive: false,
      partialTakeProfitDone: false,
      traderSold: false,
    });
    expect(action.action).toBe('HOLD');
  });
});
