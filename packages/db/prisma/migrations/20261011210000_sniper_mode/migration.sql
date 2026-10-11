-- Phase 5: independent SNIPER mode (does not alter copy-trade formulas).

CREATE TYPE "TradingStrategy" AS ENUM ('COPY', 'SNIPER');

ALTER TYPE "TradeReason" ADD VALUE IF NOT EXISTS 'SNIPER';
ALTER TYPE "TradingMode" ADD VALUE IF NOT EXISTS 'SNIPER';

ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_DATA_UNAVAILABLE';
ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_TOKEN_CONTROLS';
ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_HOLDER_RISK';
ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_ACTIVITY';
ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_NO_ROUTE';
ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_DAILY_LOSS';
ALTER TYPE "SkipReason" ADD VALUE IF NOT EXISTS 'SNIPER_DISABLED';

ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "strategy" "TradingStrategy" NOT NULL DEFAULT 'COPY';

CREATE INDEX IF NOT EXISTS "positions_userId_strategy_status_idx" ON "positions"("userId", "strategy", "status");
CREATE INDEX IF NOT EXISTS "positions_userId_strategy_chain_tokenAddress_status_idx" ON "positions"("userId", "strategy", "chain", "tokenAddress", "status");

CREATE TABLE IF NOT EXISTS "sniper_signals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'SOLANA',
    "tokenId" TEXT,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "launchpad" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "sourceTxHash" TEXT NOT NULL,
    "creatorAddress" TEXT,
    "bondingState" TEXT,
    "migrated" BOOLEAN NOT NULL DEFAULT false,
    "status" "SignalStatus" NOT NULL DEFAULT 'DETECTED',
    "skipReason" "SkipReason",
    "skipDetail" TEXT,
    "marketCapUsdAtSignal" DECIMAL(30,4),
    "liquidityUsdAtSignal" DECIMAL(30,4),
    "priceUsdAtSignal" DECIMAL(40,18),
    "riskScore" DECIMAL(8,4),
    "plannedSizeQuote" DECIMAL(40,18),
    "plannedSizeUsd" DECIMAL(30,4),
    "sizingBasis" JSONB,
    "enrichSnapshot" JSONB,
    "detectLatencyMs" INTEGER,
    "qualifyLatencyMs" INTEGER,
    "execLatencyMs" INTEGER,
    "positionId" TEXT,
    "tradeId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sniper_signals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sniper_signals_userId_sourceTxHash_tokenAddress_key" ON "sniper_signals"("userId", "sourceTxHash", "tokenAddress");
CREATE INDEX IF NOT EXISTS "sniper_signals_userId_status_createdAt_idx" ON "sniper_signals"("userId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "sniper_signals_tokenAddress_status_idx" ON "sniper_signals"("tokenAddress", "status");
CREATE INDEX IF NOT EXISTS "sniper_signals_status_createdAt_idx" ON "sniper_signals"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "sniper_signals" ADD CONSTRAINT "sniper_signals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "sniper_signals" ADD CONSTRAINT "sniper_signals_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "sniper_signals" ADD CONSTRAINT "sniper_signals_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
