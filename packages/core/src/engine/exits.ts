import { ExitStrategy } from '@copyra/db';
import type { ExitAction, ExitEvaluationInput } from './types.js';

export interface ExitLevels {
  stopLossPriceUsd: number;
  takeProfitPriceUsd: number;
  trailingTriggerPriceUsd: number;
}

/**
 * Exit price levels from entry price (spec §13).
 *
 * Both strategies share SL = entry x (1 - stopLossPct/100), default x0.90.
 * TP = entry x (1 + takeProfitPct/100), default x1.20.
 */
export function computeExitLevels(
  entryPriceUsd: number,
  config: Pick<ExitEvaluationInput['config'], 'stopLossPct' | 'takeProfitPct' | 'trailingTriggerPct'>,
): ExitLevels {
  return {
    stopLossPriceUsd: entryPriceUsd * (1 - config.stopLossPct / 100),
    takeProfitPriceUsd: entryPriceUsd * (1 + config.takeProfitPct / 100),
    trailingTriggerPriceUsd: entryPriceUsd * (1 + config.trailingTriggerPct / 100),
  };
}

/** Trailing stop = highest confirmed price x (1 - trailingDropPct/100). */
export function computeTrailingStop(highestPriceUsd: number, trailingDropPct: number): number {
  return highestPriceUsd * (1 - trailingDropPct / 100);
}

/**
 * Decides what to do with an open position right now.
 *
 * Pure function over a price observation. Called by the backend position
 * monitor, never by the frontend — the browser being closed must not change
 * whether an exit fires (spec §14).
 *
 * Precedence is deliberate:
 *   1. stop loss — capital preservation wins over everything
 *   2. trailing stop, once armed
 *   3. take profit / trailing activation
 *   4. trader sold
 * A stop loss is checked first so a violent wick down that also crosses the
 * trailing threshold still exits, rather than racing between two rules.
 */
export function evaluateExit(input: ExitEvaluationInput): ExitAction {
  const {
    config,
    exitStrategy,
    entryPriceUsd,
    currentPriceUsd,
    highestPriceUsd,
    trailingActive,
    partialTakeProfitDone,
  } = input;

  if (entryPriceUsd <= 0 || currentPriceUsd <= 0) {
    return { action: 'HOLD', detail: 'Price data unusable; holding rather than acting on bad input.' };
  }

  const levels = computeExitLevels(entryPriceUsd, config);
  const changePct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;

  // 1. Stop loss — applies to both strategies and to any remaining size.
  if (currentPriceUsd <= levels.stopLossPriceUsd) {
    return {
      action: 'SELL',
      fraction: 1,
      reason: 'STOP_LOSS',
      detail: `Price $${currentPriceUsd} at or below stop loss $${levels.stopLossPriceUsd} (${changePct.toFixed(2)}%).`,
    };
  }

  // 2. Trailing stop, once the trailing stage is armed (Option B only).
  if (exitStrategy === ExitStrategy.TRAILING && trailingActive && highestPriceUsd !== null) {
    const trailingStop = computeTrailingStop(highestPriceUsd, config.trailingDropPct);
    if (currentPriceUsd <= trailingStop) {
      return {
        action: 'SELL',
        fraction: 1,
        reason: 'TRAILING_STOP',
        detail:
          `Price $${currentPriceUsd} at or below trailing stop $${trailingStop} ` +
          `(${config.trailingDropPct}% off the $${highestPriceUsd} high).`,
      };
    }
  }

  // 3. Take profit.
  if (currentPriceUsd >= levels.takeProfitPriceUsd) {
    if (exitStrategy === ExitStrategy.MANUAL) {
      // Option A — sell the whole position at +20%.
      return {
        action: 'SELL',
        fraction: 1,
        reason: 'TAKE_PROFIT',
        detail: `Price $${currentPriceUsd} reached take profit $${levels.takeProfitPriceUsd} (+${changePct.toFixed(2)}%); selling 100%.`,
      };
    }

    // Option B — sell 50% at +20%, then trail the remainder.
    if (!partialTakeProfitDone) {
      return {
        action: 'ACTIVATE_TRAILING',
        fraction: config.trailingPartialSellPct / 100,
        detail:
          `Price $${currentPriceUsd} reached +${changePct.toFixed(2)}%; selling ` +
          `${config.trailingPartialSellPct}% and arming a ${config.trailingDropPct}% trailing stop on the remainder.`,
      };
    }
  }

  // 4. The monitored trader exited. Only honoured when configured.
  if (input.traderSold && config.followTraderSells) {
    return {
      action: 'SELL',
      fraction: 1,
      reason: 'TRADER_SOLD',
      detail: 'The monitored trader sold this token; mirroring the exit.',
    };
  }

  return {
    action: 'HOLD',
    detail: `Holding at ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% (SL $${levels.stopLossPriceUsd}, TP $${levels.takeProfitPriceUsd}).`,
  };
}

/**
 * New high-water mark for the trailing stage.
 *
 * Only tracks highs observed *after* trailing arms, per spec §13 ("Track the
 * highest confirmed price after the trailing stage activates"). Before arming,
 * the high-water mark stays null so an early spike cannot set a trailing stop
 * that was never meant to exist.
 */
export function updateHighWaterMark(
  currentHighest: number | null,
  observedPrice: number,
  trailingActive: boolean,
): number | null {
  if (!trailingActive) return currentHighest;
  if (observedPrice <= 0) return currentHighest;
  if (currentHighest === null) return observedPrice;
  return Math.max(currentHighest, observedPrice);
}

/** The "Exit plan" line in the Telegram buy notification. */
export function describeExitPlan(
  exitStrategy: ExitStrategy,
  config: Pick<
    ExitEvaluationInput['config'],
    'takeProfitPct' | 'stopLossPct' | 'trailingDropPct' | 'trailingPartialSellPct'
  >,
): string {
  if (exitStrategy === ExitStrategy.TRAILING) {
    return `TP +${fmt(config.takeProfitPct)}% (${fmt(config.trailingPartialSellPct)}%) · Trailing ${fmt(
      config.trailingDropPct,
    )}% · SL -${fmt(config.stopLossPct)}%`;
  }
  return `TP +${fmt(config.takeProfitPct)}% · SL -${fmt(config.stopLossPct)}%`;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
