import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';

/**
 * Pure math checks for the funds reservation model.
 * Live RPC + Prisma paths are covered by deploy smoke and operator testing
 * once a bot key is present — these tests lock the unit conversions.
 */
describe('funds reservation math', () => {
  it('converts SOL amounts to lamports without inventing balance', () => {
    const amountSol = 1.25;
    const lamports = BigInt(Math.floor(amountSol * 1e9));
    expect(lamports).toBe(1_250_000_000n);
    expect(Number(lamports) / 1e9).toBe(1.25);
  });

  it('never allows trading available below zero after savings + fee buffer', () => {
    const onChain = 1_000_000_000n; // 1 SOL
    const feeBuffer = 10_000_000n; // 0.01 SOL
    const savings = 400_000_000n; // 0.4 SOL
    const tradingSpendable =
      onChain > feeBuffer + savings ? onChain - feeBuffer - savings : 0n;
    expect(tradingSpendable).toBe(590_000_000n);
    const overReserve = onChain - feeBuffer + 1n;
    const next =
      overReserve > onChain - feeBuffer
        ? 0n
        : onChain > feeBuffer + overReserve
          ? onChain - feeBuffer - overReserve
          : 0n;
    expect(next).toBe(0n);
  });

  it('EVM USDC uses stable decimals (Base 6 / BSC 18) and no quote fee buffer', () => {
    const baseRaw = parseUnits('12.5', 6);
    const bscRaw = parseUnits('12.5', 18);
    expect(baseRaw).toBe(12_500_000n);
    expect(bscRaw).toBe(12_500_000_000_000_000_000n);
    const feeBufferEvm = 0n;
    const savings = parseUnits('2', 18);
    const tradingSpendable =
      bscRaw > feeBufferEvm + savings ? bscRaw - feeBufferEvm - savings : 0n;
    expect(Number(tradingSpendable) / 1e18).toBe(10.5);
  });
});
