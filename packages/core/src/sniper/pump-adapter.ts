/**
 * Pump.fun launch-platform adapter.
 *
 * Probes bonding-curve PDAs for tradeability when Jupiter has no route yet.
 * Execution still prefers Jupiter / PumpSwap when a compatible route exists;
 * bonding-curve buys are gated until a quote + preflight path succeeds.
 */
import { PublicKey } from '@solana/web3.js';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { solanaPool } from '../solana/connection.js';
import { DEFAULT_PUMP_FUN_PROGRAM_ID } from './constants.js';

const log = componentLogger('sniper-pump-adapter');

/** Official bonding-curve seed used by Pump.fun. */
const BONDING_CURVE_SEED = Buffer.from('bonding-curve');

export interface PumpBondingCurveProbe {
  programId: string;
  bondingCurve: string;
  exists: boolean;
  complete: boolean | null;
  virtualTokenReserves: bigint | null;
  virtualSolReserves: bigint | null;
  /** Rough SOL locked in the curve (from virtual SOL reserves). */
  virtualSol: number | null;
  /** Rough USD liquidity proxy when solUsd is provided. */
  liquidityUsdEstimate: number | null;
  /** Rough price in SOL per whole token (6 decimals assumed when unknown). */
  priceSolEstimate: number | null;
  tradeable: boolean;
  detail: string;
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

/**
 * Derive the bonding-curve PDA for a mint under the Pump.fun program.
 */
export function bondingCurvePda(
  mint: string,
  programId = env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, new PublicKey(mint).toBuffer()],
    new PublicKey(programId),
  );
  return pda;
}

/**
 * Read Pump.fun bonding-curve account. Layout (public reverse-engineering):
 * 8 disc | virtualTokenReserves u64 | virtualSolReserves u64 | …
 * complete flag commonly at offset 48.
 */
export async function probePumpBondingCurve(
  mint: string,
  opts?: { solUsd?: number | null; programId?: string },
): Promise<PumpBondingCurveProbe> {
  const programId = opts?.programId || env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID;
  const curve = bondingCurvePda(mint, programId);
  const base: PumpBondingCurveProbe = {
    programId,
    bondingCurve: curve.toBase58(),
    exists: false,
    complete: null,
    virtualTokenReserves: null,
    virtualSolReserves: null,
    virtualSol: null,
    liquidityUsdEstimate: null,
    priceSolEstimate: null,
    tradeable: false,
    detail: 'not-probed',
  };

  try {
    const info = await solanaPool().call('getAccountInfo', (c) => c.getAccountInfo(curve));
    const account = info.value;
    if (!account?.data) {
      return { ...base, detail: 'bonding-curve-missing' };
    }
    const data = Buffer.from(account.data);
    if (data.length < 24) {
      return { ...base, exists: true, detail: 'bonding-curve-too-short' };
    }
    const virtualTokenReserves = readU64LE(data, 8);
    const virtualSolReserves = readU64LE(data, 16);
    const complete = data.length > 48 ? data[48] === 1 : null;
    const virtualSol = Number(virtualSolReserves) / 1e9;
    const tokenRaw = Number(virtualTokenReserves);
    const priceSolEstimate =
      tokenRaw > 0 ? virtualSol / (tokenRaw / 1e6) : null;
    const solUsd = opts?.solUsd && opts.solUsd > 0 ? opts.solUsd : null;
    const liquidityUsdEstimate = solUsd != null ? virtualSol * solUsd : null;
    const tradeable =
      complete === false &&
      virtualSolReserves > 0n &&
      virtualTokenReserves > 0n;

    return {
      programId,
      bondingCurve: curve.toBase58(),
      exists: true,
      complete,
      virtualTokenReserves,
      virtualSolReserves,
      virtualSol,
      liquidityUsdEstimate,
      priceSolEstimate,
      tradeable,
      detail: tradeable
        ? 'bonding-curve-active'
        : complete
          ? 'bonding-curve-migrated'
          : 'bonding-curve-not-tradeable',
    };
  } catch (error) {
    log.warn({ mint, err: error }, 'pump bonding-curve probe failed');
    return { ...base, detail: `probe-error:${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Prefer Jupiter when available; otherwise use an active Pump.fun bonding curve
 * as evidence of a launch-specific buy/sell path (fail-closed if neither works).
 */
export function resolveSniperExecutionRoute(input: {
  jupiterBuyOk: boolean;
  jupiterSellOk: boolean;
  pump: PumpBondingCurveProbe | null;
}): {
  route: 'jupiter' | 'pump.fun' | 'none';
  buyRouteOk: boolean;
  sellRouteOk: boolean;
  detail: string;
} {
  if (input.jupiterBuyOk && input.jupiterSellOk) {
    return {
      route: 'jupiter',
      buyRouteOk: true,
      sellRouteOk: true,
      detail: 'jupiter-bidirectional',
    };
  }
  if (input.pump?.tradeable) {
    // Bonding-curve tokens can buy+sell on the curve before migration.
    return {
      route: 'pump.fun',
      buyRouteOk: true,
      sellRouteOk: true,
      detail: input.pump.detail,
    };
  }
  return {
    route: 'none',
    buyRouteOk: input.jupiterBuyOk,
    sellRouteOk: input.jupiterSellOk,
    detail: input.pump?.detail ?? 'no-compatible-route',
  };
}
