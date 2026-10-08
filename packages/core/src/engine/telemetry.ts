/**
 * Execution telemetry (spec §11).
 *
 * Every stage boundary in the copy-trade pipeline is stamped with a real
 * monotonic reading. Nothing here is estimated or back-filled: a stage with no
 * timestamp means that stage did not happen, which is itself the signal we want
 * when diagnosing a missed trade.
 *
 * Latency is measured, never asserted. `LatencyReport.claimsVerified` is false
 * until there is at least one confirmed trade to measure, so the UI cannot
 * display a speed figure that no transaction supports.
 */

export const TELEMETRY_STAGES = [
  'sourceDetected',
  'decoded',
  'qualified',
  'riskChecked',
  'quoted',
  'built',
  'signed',
  'broadcast',
  'landed',
  'confirmed',
] as const;

export type TelemetryStage = (typeof TELEMETRY_STAGES)[number];

export interface StageMark {
  stage: TelemetryStage | string;
  /** Wall-clock, for correlation with explorer timestamps. */
  at: Date;
  /** High-resolution monotonic ms since the tracker started. */
  offsetMs: number;
}

export class TelemetryTracker {
  readonly startedAt: Date;
  readonly marks: StageMark[] = [];
  readonly #origin: number;
  readonly #byStage = new Map<string, StageMark>();

  constructor(startedAt: Date = new Date()) {
    this.startedAt = startedAt;
    this.#origin = performance.now();
    this.mark('sourceDetected', startedAt);
  }

  mark(stage: TelemetryStage | string, at: Date = new Date()): StageMark {
    const mark: StageMark = {
      stage,
      at,
      offsetMs: Math.round(performance.now() - this.#origin),
    };
    this.marks.push(mark);
    this.#byStage.set(stage, mark);
    return mark;
  }

  at(stage: TelemetryStage | string): Date | undefined {
    return this.#byStage.get(stage)?.at;
  }

  /** Elapsed ms between two stages, or undefined if either is missing. */
  between(from: TelemetryStage | string, to: TelemetryStage | string): number | undefined {
    const a = this.#byStage.get(from);
    const b = this.#byStage.get(to);
    if (!a || !b) return undefined;
    return b.offsetMs - a.offsetMs;
  }

  sinceStart(stage: TelemetryStage | string): number | undefined {
    return this.#byStage.get(stage)?.offsetMs;
  }

  /** Flattened Prisma-ready field set. Absent stages stay null. */
  toTradeFields(): Record<string, Date | number | null> {
    const d = (stage: TelemetryStage): Date | null => this.at(stage) ?? null;
    return {
      sourceDetectedAt: d('sourceDetected'),
      decodedAt: d('decoded'),
      qualifiedAt: d('qualified'),
      quotedAt: d('quoted'),
      builtAt: d('built'),
      signedAt: d('signed'),
      broadcastAt: d('broadcast'),
      landedAt: d('landed'),
      confirmedAt: d('confirmed'),
      quoteLatencyMs: this.between('riskChecked', 'quoted') ?? this.between('qualified', 'quoted') ?? null,
      buildLatencyMs: this.between('quoted', 'built') ?? null,
      signLatencyMs: this.between('built', 'signed') ?? null,
      broadcastLatencyMs: this.between('signed', 'broadcast') ?? null,
      confirmLatencyMs: this.between('broadcast', 'confirmed') ?? null,
      totalLatencyMs: this.sinceStart('confirmed') ?? null,
    };
  }

  toSignalFields(): Record<string, Date | number | null> {
    const d = (stage: TelemetryStage): Date | null => this.at(stage) ?? null;
    return {
      detectedAt: this.startedAt,
      decodedAt: d('decoded'),
      qualifiedAt: d('qualified'),
      riskCheckedAt: d('riskChecked'),
      quotedAt: d('quoted'),
      builtAt: d('built'),
      signedAt: d('signed'),
      broadcastAt: d('broadcast'),
      landedAt: d('landed'),
      confirmedAt: d('confirmed'),
      detectToBroadcastMs: this.sinceStart('broadcast') ?? null,
      detectToConfirmMs: this.sinceStart('confirmed') ?? null,
    };
  }

  summary(): Record<string, number | undefined> {
    return {
      detectToDecode: this.between('sourceDetected', 'decoded'),
      decodeToQualify: this.between('decoded', 'qualified'),
      qualifyToQuote: this.between('qualified', 'quoted'),
      quoteToBuild: this.between('quoted', 'built'),
      buildToSign: this.between('built', 'signed'),
      signToBroadcast: this.between('signed', 'broadcast'),
      broadcastToConfirm: this.between('broadcast', 'confirmed'),
      detectToBroadcast: this.sinceStart('broadcast'),
      detectToConfirm: this.sinceStart('confirmed'),
    };
  }
}

export interface LatencyReport {
  sampleSize: number;
  detectToBroadcastMs: { p50: number; p95: number; min: number; max: number } | null;
  detectToConfirmMs: { p50: number; p95: number; min: number; max: number } | null;
  /**
   * False until real confirmed trades exist. The dashboard must not present a
   * latency claim that no measurement supports (spec §11).
   */
  claimsVerified: boolean;
  note: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

function stats(values: number[]): LatencyReport['detectToBroadcastMs'] {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

export function buildLatencyReport(
  broadcastSamples: number[],
  confirmSamples: number[],
): LatencyReport {
  const sampleSize = Math.max(broadcastSamples.length, confirmSamples.length);
  return {
    sampleSize,
    detectToBroadcastMs: stats(broadcastSamples),
    detectToConfirmMs: stats(confirmSamples),
    claimsVerified: confirmSamples.length > 0,
    note:
      confirmSamples.length > 0
        ? `Measured from ${confirmSamples.length} confirmed on-chain transaction(s).`
        : 'No confirmed transactions yet. No latency claim can be made.',
  };
}
