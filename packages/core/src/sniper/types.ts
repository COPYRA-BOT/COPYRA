import type { SkipReason } from '@copyra/db';

/** Runtime sniper host mode — monitor never broadcasts; live buys when enabled. */
export type SniperRuntimeMode = 'monitor' | 'onchain' | 'live';

export type SniperLaunchpad = 'pump.fun' | 'pumpswap' | 'raydium' | 'unknown';

export interface SniperDiscoveryEvent {
  launchpad: SniperLaunchpad;
  eventKind: 'create' | 'migrate' | 'pool' | 'buy';
  sourceTxHash: string;
  tokenAddress: string;
  creatorAddress: string | null;
  bondingState: 'bonding_curve' | 'migrated' | 'unknown';
  migrated: boolean;
  observedAt: Date;
  slot: number | null;
  rawLog?: string;
}

export interface SniperEnrichment {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketSource: string | null;
  marketAgeMs: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  topHolderPct: number | null;
  holderCount: number | null;
  swapActivityOk: boolean | null;
  buyRouteOk: boolean | null;
  sellRouteOk: boolean | null;
  /** Preferred execution path after enrichment. */
  executionRoute: 'jupiter' | 'pump.fun' | 'none' | null;
  priceImpactBps: number | null;
  expectedSlippageBps: number | null;
  blacklistHit: boolean;
  enrichErrors: string[];
}

export interface SniperConfig {
  enabled: boolean;
  runtimeMode: SniperRuntimeMode;
  maxMarketCapUsd: number;
  minLiquidityUsd: number;
  maxPriceImpactBps: number;
  maxSlippageBps: number;
  maxOpenPositions: number;
  maxPositionSol: number;
  maxDeployedSol: number;
  dailyLossLimitSol: number;
  allowedLaunchpads: SniperLaunchpad[];
  marketDataMaxAgeMs: number;
  pumpFunProgramId: string;
  /** From UserModeSettings — exits / sizing share StrategyConfig shape. */
  takeProfitPct: number;
  stopLossPct: number;
  exitStrategy: 'MANUAL' | 'TRAILING';
  tradeAllocationPct: number;
  reservePct: number;
  minTradeUsd: number;
  maxDeploymentPct: number;
  engineOn: boolean;
  emergencyStop: boolean;
  tokenBlacklist: string[];
}

export type SniperQualifyResult =
  | { qualified: true; riskScore: number }
  | { qualified: false; reason: SkipReason; detail: string };
