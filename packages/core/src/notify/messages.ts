import { Chain, ExitStrategy, type SkipReason, type TradeReason } from '@copyra/db';
import { chainConfig, explorerTxUrl } from '../config/chains.js';
import { describeExitPlan } from '../engine/exits.js';
import {
  compactUsd,
  escapeHtml,
  formatDuration,
  formatNative,
  formatPct,
  formatPrice,
  formatSignedNative,
  formatSignedPct,
  formatSpeed,
  plainUsd,
  shortAddress,
} from './format.js';

/**
 * COPYRA notification templates.
 *
 * The BUY and SELL layouts reproduce the spec's message structure line for
 * line. Values that have not been measured render as "not measured" rather than
 * as a plausible-looking number. A notification is a record of what actually
 * happened on chain, so fabricating a figure here would be the worst place of all
 * to put one.
 */

export interface BuyNotification {
  chain: Chain;
  tokenSymbol: string;
  tokenAddress: string;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  traderLabel: string;
  traderAddress: string;
  /** Quote asset spent, in whole units. */
  spentQuote: number;
  spentUsd: number | null;
  /** Share of the available trading balance this trade consumed. */
  balanceSharePct: number | null;
  executionPriceUsd: number | null;
  requestedSlippageBps: number;
  realizedSlippagePct: number | null;
  priceImpactPct: number | null;
  feeNative: number | null;
  /** Measured detection-to-confirmation latency. */
  speedMs: number | null;
  exitStrategy: ExitStrategy;
  exitConfig: {
    takeProfitPct: number;
    stopLossPct: number;
    trailingDropPct: number;
    trailingPartialSellPct: number;
  };
  balanceQuote: number;
  balanceUsd: number | null;
  openPnlQuote: number;
  txHash: string;
}

export function renderBuy(n: BuyNotification): string {
  const config = chainConfig(n.chain);
  const symbol = config.quoteAssetSymbol;
  const lines: string[] = [];

  lines.push(`🟢 <b>BUY · ${config.code}</b>`);
  lines.push(
    `$${escapeHtml(n.tokenSymbol)} · MC ${compactUsd(n.marketCapUsd)} · Liq ${compactUsd(n.liquidityUsd)}`,
  );
  lines.push('');
  lines.push(`Trader: ${escapeHtml(n.traderLabel)} (${shortAddress(n.traderAddress)})`);

  const spent = [`Spent: ${formatNative(n.spentQuote, symbol)}`];
  if (n.spentUsd !== null) spent.push(`(${plainUsd(n.spentUsd)})`);
  if (n.balanceSharePct !== null) spent.push(`· ${n.balanceSharePct.toFixed(0)}%`);
  lines.push(spent.join(' '));

  lines.push(`Price: ${formatPrice(n.executionPriceUsd)}`);
  lines.push(
    `Slippage ${formatPct(n.requestedSlippageBps / 100, 2)}` +
      (n.realizedSlippagePct !== null ? ` (realized ${formatPct(n.realizedSlippagePct, 2)})` : '') +
      ` · Impact ${formatPct(n.priceImpactPct, 2)}`,
  );
  lines.push(
    `Fee: ${n.feeNative !== null ? formatNative(n.feeNative, config.nativeSymbol) : 'n/a'} · Speed: ${formatSpeed(n.speedMs)}`,
  );
  lines.push('');
  lines.push(`Exit plan: ${describeExitPlan(n.exitStrategy, n.exitConfig)}`);
  lines.push('');
  lines.push(
    `Balance: ${formatNative(n.balanceQuote, symbol)}` +
      (n.balanceUsd !== null ? ` (${plainUsd(n.balanceUsd)})` : ''),
  );
  lines.push(`Open P&amp;L: ${formatSignedNative(n.openPnlQuote, symbol)}`);
  lines.push('');
  lines.push(`🔗 <a href="${explorerTxUrl(n.chain, n.txHash)}">${config.explorerName}</a>`);

  return lines.join('\n');
}

export interface SellNotification {
  chain: Chain;
  reason: TradeReason;
  tokenSymbol: string;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  traderLabel: string;
  traderAddress: string;
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  /** Quote spent on entry, and quote returned on exit. */
  entryQuote: number;
  exitQuote: number;
  feeNative: number | null;
  speedMs: number | null;
  heldMs: number | null;
  pnlQuote: number;
  pnlPct: number;
  balanceQuote: number;
  balanceUsd: number | null;
  totalPnlQuote: number;
  txHash: string;
  /** Present for a partial exit, e.g. the +20% half-sell of Option B. */
  portionPct?: number;
}

const REASON_LABEL: Record<string, string> = {
  TAKE_PROFIT: 'TAKE PROFIT',
  STOP_LOSS: 'STOP LOSS',
  TRAILING_STOP: 'TRAILING STOP',
  TRADER_SOLD: 'TRADER SOLD',
  MANUAL: 'MANUAL',
  EMERGENCY_STOP: 'EMERGENCY STOP',
  COPY: 'COPY',
};

export function renderSell(n: SellNotification): string {
  const config = chainConfig(n.chain);
  const symbol = config.quoteAssetSymbol;
  const profitable = n.pnlQuote >= 0;
  const lines: string[] = [];

  lines.push(
    `${profitable ? '🟢' : '🔴'} <b>SELL · ${REASON_LABEL[n.reason] ?? n.reason} · ${config.code}</b>`,
  );
  lines.push(
    `$${escapeHtml(n.tokenSymbol)} · MC ${compactUsd(n.marketCapUsd)} · Liq ${compactUsd(n.liquidityUsd)}`,
  );
  lines.push('');
  lines.push(`Trader: ${escapeHtml(n.traderLabel)} (${shortAddress(n.traderAddress)})`);
  lines.push(`Entry: ${formatPrice(n.entryPriceUsd)} → Exit: ${formatPrice(n.exitPriceUsd)}`);
  lines.push(
    `Sold: ${formatNative(n.entryQuote, symbol)} → ${formatNative(n.exitQuote, symbol)}` +
      (n.portionPct !== undefined && n.portionPct < 100 ? ` (${n.portionPct.toFixed(0)}% of position)` : ''),
  );
  lines.push(
    `Fee: ${n.feeNative !== null ? formatNative(n.feeNative, config.nativeSymbol) : 'n/a'} · Speed: ${formatSpeed(n.speedMs)}`,
  );
  lines.push(`Held: ${formatDuration(n.heldMs)}`);
  lines.push('');
  lines.push(
    `<b>${profitable ? 'PROFIT' : 'LOSS'}: ${formatSignedNative(n.pnlQuote, symbol)} (${formatSignedPct(n.pnlPct)})</b>`,
  );
  lines.push('');
  lines.push(
    `Balance: ${formatNative(n.balanceQuote, symbol)}` +
      (n.balanceUsd !== null ? ` (${plainUsd(n.balanceUsd)})` : ''),
  );
  lines.push(`Total P&amp;L: ${formatSignedNative(n.totalPnlQuote, symbol)}`);
  lines.push('');
  lines.push(`🔗 <a href="${explorerTxUrl(n.chain, n.txHash)}">${config.explorerName}</a>`);

  return lines.join('\n');
}

export interface SkipNotification {
  chain: Chain;
  tokenSymbol: string | null;
  tokenAddress: string;
  traderLabel: string;
  traderAddress: string;
  reason: SkipReason;
  detail: string;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  sourceTxHash: string;
}

export function renderSkip(n: SkipNotification): string {
  const config = chainConfig(n.chain);
  return [
    `⚪️ <b>SKIPPED · ${config.code}</b>`,
    `$${escapeHtml(n.tokenSymbol ?? shortAddress(n.tokenAddress, 6, 4))} · MC ${compactUsd(
      n.marketCapUsd,
    )} · Liq ${compactUsd(n.liquidityUsd)}`,
    '',
    `Trader: ${escapeHtml(n.traderLabel)} (${shortAddress(n.traderAddress)})`,
    `Reason: <b>${n.reason}</b>`,
    escapeHtml(n.detail),
    '',
    `🔗 <a href="${explorerTxUrl(n.chain, n.sourceTxHash)}">${config.explorerName} (trader tx)</a>`,
  ].join('\n');
}

export interface DetectionNotification {
  chain: Chain;
  traderLabel: string;
  traderAddress: string;
  classification: string;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  sourceTxHash: string;
  detectLatencyMs: number | null;
}

export function renderDetection(n: DetectionNotification): string {
  const config = chainConfig(n.chain);
  return [
    `👁 <b>TRADER ACTIVITY · ${config.code}</b>`,
    `${escapeHtml(n.traderLabel)} (${shortAddress(n.traderAddress)}). ${n.classification}`,
    n.tokenAddress
      ? `Token: $${escapeHtml(n.tokenSymbol ?? shortAddress(n.tokenAddress, 6, 4))}`
      : 'No token leg',
    `Detected in ${formatSpeed(n.detectLatencyMs)} from block time`,
    `🔗 <a href="${explorerTxUrl(n.chain, n.sourceTxHash)}">${config.explorerName}</a>`,
  ].join('\n');
}

export interface SubmissionNotification {
  chain: Chain;
  side: 'BUY' | 'SELL';
  reason: TradeReason;
  tokenSymbol: string;
  amountQuote: number;
  txHash: string;
  broadcastLatencyMs: number | null;
}

export function renderSubmitted(n: SubmissionNotification): string {
  const config = chainConfig(n.chain);
  return [
    `📡 <b>${n.side} SUBMITTED · ${config.code}</b>`,
    `$${escapeHtml(n.tokenSymbol)} · ${formatNative(n.amountQuote, config.quoteAssetSymbol)}`,
    `Reason: ${REASON_LABEL[n.reason] ?? n.reason}`,
    `Broadcast after ${formatSpeed(n.broadcastLatencyMs)}`,
    'Awaiting on chain confirmation. This is <i>not</i> yet an executed trade.',
    `🔗 <a href="${explorerTxUrl(n.chain, n.txHash)}">${config.explorerName}</a>`,
  ].join('\n');
}

export interface FailureNotification {
  chain: Chain;
  side: 'BUY' | 'SELL';
  tokenSymbol: string | null;
  errorCode: string;
  errorMessage: string;
  txHash: string | null;
  attempts: number;
}

export function renderFailure(n: FailureNotification): string {
  const config = chainConfig(n.chain);
  const lines = [
    `❌ <b>${n.side} FAILED · ${config.code}</b>`,
    n.tokenSymbol ? `$${escapeHtml(n.tokenSymbol)}` : '',
    `Code: <b>${escapeHtml(n.errorCode)}</b> after ${n.attempts} attempt(s)`,
    escapeHtml(n.errorMessage.slice(0, 500)),
  ].filter(Boolean);
  if (n.txHash) {
    lines.push(`🔗 <a href="${explorerTxUrl(n.chain, n.txHash)}">${config.explorerName}</a>`);
  } else {
    lines.push('No transaction was broadcast. No funds moved.');
  }
  return lines.join('\n');
}

export interface TrailingActivatedNotification {
  chain: Chain;
  tokenSymbol: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  soldPct: number;
  trailingDropPct: number;
  trailingStopPriceUsd: number;
  txHash: string;
}

export function renderTrailingActivated(n: TrailingActivatedNotification): string {
  const config = chainConfig(n.chain);
  const gainPct = ((n.currentPriceUsd - n.entryPriceUsd) / n.entryPriceUsd) * 100;
  return [
    `📈 <b>TRAILING ARMED · ${config.code}</b>`,
    `$${escapeHtml(n.tokenSymbol)} at ${formatSignedPct(gainPct)}`,
    '',
    `Sold ${n.soldPct.toFixed(0)}% at ${formatPrice(n.currentPriceUsd)}`,
    `Remainder now trails ${n.trailingDropPct}% below the high`,
    `Current trailing stop: ${formatPrice(n.trailingStopPriceUsd)}`,
    '',
    `🔗 <a href="${explorerTxUrl(n.chain, n.txHash)}">${config.explorerName}</a>`,
  ].join('\n');
}

export interface SystemAlertNotification {
  level: 'WARN' | 'ERROR' | 'CRITICAL';
  component: string;
  code: string;
  message: string;
  detail?: string;
}

export function renderSystemAlert(n: SystemAlertNotification): string {
  const icon = n.level === 'CRITICAL' ? '🚨' : n.level === 'ERROR' ? '⛔️' : '⚠️';
  return [
    `${icon} <b>${n.level} · ${escapeHtml(n.component)}</b>`,
    `<code>${escapeHtml(n.code)}</code>`,
    escapeHtml(n.message.slice(0, 800)),
    n.detail ? `\n${escapeHtml(n.detail.slice(0, 400))}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface EmergencyStopNotification {
  engaged: boolean;
  reason: string;
  openPositions: number;
  by: string;
}

export function renderEmergencyStop(n: EmergencyStopNotification): string {
  if (n.engaged) {
    return [
      '🛑 <b>EMERGENCY STOP ENGAGED</b>',
      '',
      `Reason: ${escapeHtml(n.reason)}`,
      `By: ${escapeHtml(n.by)}`,
      `Open positions: ${n.openPositions} (still monitored for exits)`,
      '',
      'No new positions will be opened. Existing TP/SL rules remain active.',
    ].join('\n');
  }
  return [
    '✅ <b>EMERGENCY STOP CLEARED</b>',
    '',
    `By: ${escapeHtml(n.by)}`,
    'Copy trading has resumed.',
  ].join('\n');
}

export interface LatencyNotification {
  sampleSize: number;
  p50BroadcastMs: number | null;
  p50ConfirmMs: number | null;
  p95ConfirmMs: number | null;
  claimsVerified: boolean;
}

export function renderLatency(n: LatencyNotification): string {
  if (!n.claimsVerified) {
    return [
      '⏱ <b>LATENCY REPORT</b>',
      '',
      'No confirmed on-chain trades yet, so no latency figure can be stated.',
    ].join('\n');
  }
  return [
    '⏱ <b>LATENCY REPORT</b>',
    '',
    `Sample: ${n.sampleSize} confirmed trade(s)`,
    `Detect → broadcast (p50): ${formatSpeed(n.p50BroadcastMs)}`,
    `Detect → confirmed (p50): ${formatSpeed(n.p50ConfirmMs)}`,
    `Detect → confirmed (p95): ${formatSpeed(n.p95ConfirmMs)}`,
    '',
    '<i>Measured from real transactions, not a target.</i>',
  ].join('\n');
}

export { REASON_LABEL };
