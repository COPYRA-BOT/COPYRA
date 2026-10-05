export const CHAINS = [
  'SOLANA',
  'ETHEREUM',
  'BASE',
  'ARBITRUM',
  'BSC',
  'POLYGON',
  'OPTIMISM',
  'ARC',
  'ROBINHOOD',
  'HYPERLIQUID',
  'TRON',
] as const;

export type Chain = (typeof CHAINS)[number];

export interface ChainStatus {
  chain: Chain;
  label: string;
  code: string;
  kind: 'solana' | 'evm';
  canExecute: boolean;
  executionBlockedReason: string | null;
  explorerName: string;
  nativeSymbol: string;
  head: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface WorkerHeartbeat {
  name: string;
  status: string;
  beatAt: string;
  detail?: Record<string, unknown> | null;
}

export interface StatusResponse {
  trading: {
    envGuard: boolean;
    settingsEnabled: boolean;
    emergencyStop: boolean;
    blockedReason: string | null;
    observeOnly: boolean;
  };
  signers: {
    solana: { available: boolean; address: string | null };
    evm: { available: boolean; address: string | null };
  };
  telegram: {
    tokenValid: boolean;
    botUsername: string | null;
    canPostToChat: boolean;
    chatTitle: string | null;
    error?: string;
  };
  chains: ChainStatus[];
  executableChains: Chain[];
  workers: WorkerHeartbeat[];
  counts: { openPositions: number; signals24h: number; confirmedTrades: number };
  latency: {
    broadcastCount: number;
    confirmCount: number;
    claimsVerified: boolean;
    p50BroadcastMs?: number | null;
    p50ConfirmMs?: number | null;
    note?: string;
  };
  socials: { x: string; telegram: string; domain: string };
}

export interface StrategyRow {
  id: number;
  tradingEnabled: boolean;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
  emergencyStopAt: string | null;
  exitStrategy: 'MANUAL' | 'TRAILING';
  minMarketCapUsd: string | number;
  maxMarketCapUsd: string | number;
  maxDeploymentPct: string | number;
  maxOpenPositions: number;
  reservePct: string | number;
  minTradeUsd: string | number;
  maxSlippageBps: number;
  maxPriceImpactPct: string | number;
  minLiquidityUsd: string | number;
  takeProfitPct: string | number;
  stopLossPct: string | number;
  trailingTriggerPct: string | number;
  trailingPartialSellPct: string | number;
  trailingDropPct: string | number;
  followTraderSells: boolean;
  enabledChains: Chain[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface SettingsResponse {
  row: StrategyRow;
  effective: Record<string, unknown>;
  blockedReason: string | null;
}

export interface Trader {
  id: string;
  chain: Chain;
  address: string;
  label: string;
  enabled: boolean;
  notes: string | null;
  lastActivityAt: string | null;
  lastSignature: string | null;
  createdAt: string;
}

export interface Token {
  id: string;
  chain: Chain;
  address: string;
  symbol: string | null;
  name: string | null;
  priceUsd?: string | number | null;
  marketCapUsd?: string | number | null;
  liquidityUsd?: string | number | null;
}

export interface Trade {
  id: string;
  chain: Chain;
  side: 'BUY' | 'SELL';
  reason: string;
  status: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  valueUsd?: string | number | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface Position {
  id: string;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol: string | null;
  status: string;
  quoteAssetSymbol: string;
  exitStrategy: 'MANUAL' | 'TRAILING';
  entryValueUsd?: string | number | null;
  lastPriceUsd?: string | number | null;
  unrealizedPnlUsd?: string | number | null;
  unrealizedPnlPct?: string | number | null;
  realizedPnlUsd?: string | number | null;
  correlatedTraders: number;
  openedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  token?: Token | null;
  trades?: Trade[];
}

export interface Signal {
  id: string;
  chain: Chain;
  status: string;
  skipReason: string | null;
  classification: string;
  sourceTx: string;
  tokenAddress: string;
  createdAt: string;
  trader?: Trader | null;
  token?: Token | null;
}

export interface SystemEvent {
  id: string;
  level: string;
  component: string;
  code: string;
  message: string;
  createdAt: string;
}

export interface PnlResponse {
  since: string;
  realizedQuote: number;
  unrealizedQuote: number;
  openCount: number;
  closedCount: number;
}

export interface BalanceWallet {
  chain: Chain;
  configured: boolean;
  address: string | null;
  native?: number;
  nativeRaw?: string;
  tokens?: unknown;
  slot?: string;
  source?: string;
  error?: string;
  detail?: string;
}

export interface BalancesResponse {
  buckets: { trading: string; savings: string };
  wallets: BalanceWallet[];
}

export interface AuthMe {
  authenticated: boolean;
  user: { id: string; address: string; chain: Chain; label: string | null } | null;
}

export interface NotificationLog {
  id: string;
  channel: string;
  kind: string;
  delivered: boolean;
  createdAt: string;
  error?: string | null;
}

export interface OnchainWallet {
  chain: Chain;
  address: string;
  native: number;
  nativeSymbol: string;
  tokens?: unknown;
  slot?: string;
  block?: string;
  source: string;
  readAt: string;
}
