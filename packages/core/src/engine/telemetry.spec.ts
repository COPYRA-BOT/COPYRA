import { describe, expect, it } from 'vitest';
import { buildLatencyReport, TelemetryTracker } from './telemetry.js';

describe('TelemetryTracker', () => {
  it('stamps every stage and leaves unvisited stages null', () => {
    const tracker = new TelemetryTracker(new Date('2026-10-05T00:00:00.000Z'));
    tracker.mark('decoded');
    tracker.mark('qualified');
    tracker.mark('quoted');

    const fields = tracker.toTradeFields();
    expect(fields.sourceDetectedAt).toBeInstanceOf(Date);
    expect(fields.decodedAt).toBeInstanceOf(Date);
    expect(fields.qualifiedAt).toBeInstanceOf(Date);
    expect(fields.quotedAt).toBeInstanceOf(Date);
    expect(fields.signedAt).toBeNull();
    expect(fields.broadcastAt).toBeNull();
    expect(fields.confirmedAt).toBeNull();
    expect(fields.totalLatencyMs).toBeNull();
  });

  it('measures between stages and refuses to invent a missing interval', () => {
    const tracker = new TelemetryTracker();
    tracker.mark('quoted');
    tracker.mark('built');
    expect(tracker.between('quoted', 'built')).toBeGreaterThanOrEqual(0);
    expect(tracker.between('signed', 'broadcast')).toBeUndefined();
  });
});

describe('buildLatencyReport', () => {
  it('sets claimsVerified=false when no confirmed trades exist', () => {
    const report = buildLatencyReport([], []);
    expect(report.claimsVerified).toBe(false);
    expect(report.detectToConfirmMs).toBeNull();
    expect(report.note).toMatch(/No confirmed transactions/);
  });

  it('reports measured percentiles only from real samples', () => {
    const report = buildLatencyReport([800, 1200, 2000], [1500, 1800, 4000]);
    expect(report.claimsVerified).toBe(true);
    expect(report.sampleSize).toBe(3);
    expect(report.detectToConfirmMs?.min).toBe(1500);
    expect(report.detectToConfirmMs?.max).toBe(4000);
    expect(report.detectToConfirmMs?.p50).toBeGreaterThan(0);
    expect(report.note).toMatch(/3 confirmed/);
  });
});
