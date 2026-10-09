-- Per-user, per-mode (SOL / EVM) strategy settings.
-- Global strategy_settings remains the host emergency/seed row.

DO $$ BEGIN
  CREATE TYPE "TradingMode" AS ENUM ('SOL', 'EVM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "user_mode_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'PAUSED',
    "exitStrategy" "ExitStrategy" NOT NULL DEFAULT 'MANUAL',
    "minMarketCapUsd" DECIMAL(30,4) NOT NULL DEFAULT 1000000,
    "maxMarketCapUsd" DECIMAL(30,4) NOT NULL DEFAULT 20000000,
    "maxDeploymentPct" DECIMAL(6,3) NOT NULL DEFAULT 80,
    "tier1MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 20,
    "tier2MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 30,
    "tier3MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 40,
    "tier4MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 50,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 5,
    "tradeAllocationPct" DECIMAL(6,3) NOT NULL DEFAULT 50,
    "maxCapitalPerTokenPct" DECIMAL(6,3) NOT NULL DEFAULT 50,
    "reservePct" DECIMAL(6,3) NOT NULL DEFAULT 20,
    "minTradeUsd" DECIMAL(20,4) NOT NULL DEFAULT 10,
    "autoTransferFromSavings" BOOLEAN NOT NULL DEFAULT false,
    "maxSlippageBps" INTEGER NOT NULL DEFAULT 100,
    "maxPriceImpactPct" DECIMAL(10,6) NOT NULL DEFAULT 3,
    "minLiquidityUsd" DECIMAL(30,4) NOT NULL DEFAULT 50000,
    "quoteMaxAgeMs" INTEGER NOT NULL DEFAULT 3000,
    "confirmTimeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "maxExecutionAttempts" INTEGER NOT NULL DEFAULT 3,
    "takeProfitPct" DECIMAL(8,4) NOT NULL DEFAULT 20,
    "stopLossPct" DECIMAL(8,4) NOT NULL DEFAULT 10,
    "trailingTriggerPct" DECIMAL(8,4) NOT NULL DEFAULT 20,
    "trailingPartialSellPct" DECIMAL(8,4) NOT NULL DEFAULT 50,
    "trailingDropPct" DECIMAL(8,4) NOT NULL DEFAULT 15,
    "followTraderSells" BOOLEAN NOT NULL DEFAULT true,
    "firstBuyOnly" BOOLEAN NOT NULL DEFAULT true,
    "ui" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "user_mode_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_mode_settings_userId_mode_key"
  ON "user_mode_settings"("userId", "mode");
CREATE INDEX IF NOT EXISTS "user_mode_settings_userId_idx"
  ON "user_mode_settings"("userId");

DO $$ BEGIN
  ALTER TABLE "user_mode_settings"
    ADD CONSTRAINT "user_mode_settings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Seed SOL rows for existing users from the global strategy row + legacy ui.sol.
INSERT INTO "user_mode_settings" (
  "id", "userId", "mode", "engine", "exitStrategy",
  "minMarketCapUsd", "maxMarketCapUsd",
  "maxDeploymentPct", "tier1MaxPct", "tier2MaxPct", "tier3MaxPct", "tier4MaxPct",
  "maxOpenPositions", "tradeAllocationPct", "maxCapitalPerTokenPct",
  "reservePct", "minTradeUsd", "autoTransferFromSavings",
  "maxSlippageBps", "maxPriceImpactPct", "minLiquidityUsd",
  "quoteMaxAgeMs", "confirmTimeoutMs", "maxExecutionAttempts",
  "takeProfitPct", "stopLossPct", "trailingTriggerPct",
  "trailingPartialSellPct", "trailingDropPct",
  "followTraderSells", "firstBuyOnly", "ui", "updatedAt", "updatedBy"
)
SELECT
  'ums_sol_' || u."id",
  u."id",
  'SOL'::"TradingMode",
  COALESCE(
    NULLIF(UPPER(TRIM(s."ui" #>> '{sol,engine}')), ''),
    CASE WHEN s."tradingEnabled" THEN 'ON' ELSE 'PAUSED' END
  ),
  s."exitStrategy",
  s."minMarketCapUsd",
  s."maxMarketCapUsd",
  s."maxDeploymentPct",
  s."tier1MaxPct",
  s."tier2MaxPct",
  s."tier3MaxPct",
  s."tier4MaxPct",
  s."maxOpenPositions",
  COALESCE(NULLIF(s."ui" #>> '{sol,alloc}', '')::numeric, 50),
  COALESCE(NULLIF(s."ui" #>> '{sol,maxTok}', '')::numeric, 50),
  s."reservePct",
  s."minTradeUsd",
  s."autoTransferFromSavings",
  s."maxSlippageBps",
  s."maxPriceImpactPct",
  s."minLiquidityUsd",
  s."quoteMaxAgeMs",
  s."confirmTimeoutMs",
  s."maxExecutionAttempts",
  s."takeProfitPct",
  s."stopLossPct",
  s."trailingTriggerPct",
  s."trailingPartialSellPct",
  s."trailingDropPct",
  s."followTraderSells",
  s."firstBuyOnly",
  s."ui" -> 'sol',
  NOW(),
  'migration:user_mode_settings'
FROM "users" u
JOIN "strategy_settings" s ON s."id" = 1
ON CONFLICT ("userId", "mode") DO NOTHING;

-- Seed EVM rows independently (same defaults, own engine/ui overlay).
INSERT INTO "user_mode_settings" (
  "id", "userId", "mode", "engine", "exitStrategy",
  "minMarketCapUsd", "maxMarketCapUsd",
  "maxDeploymentPct", "tier1MaxPct", "tier2MaxPct", "tier3MaxPct", "tier4MaxPct",
  "maxOpenPositions", "tradeAllocationPct", "maxCapitalPerTokenPct",
  "reservePct", "minTradeUsd", "autoTransferFromSavings",
  "maxSlippageBps", "maxPriceImpactPct", "minLiquidityUsd",
  "quoteMaxAgeMs", "confirmTimeoutMs", "maxExecutionAttempts",
  "takeProfitPct", "stopLossPct", "trailingTriggerPct",
  "trailingPartialSellPct", "trailingDropPct",
  "followTraderSells", "firstBuyOnly", "ui", "updatedAt", "updatedBy"
)
SELECT
  'ums_evm_' || u."id",
  u."id",
  'EVM'::"TradingMode",
  COALESCE(
    NULLIF(UPPER(TRIM(s."ui" #>> '{evm,engine}')), ''),
    CASE WHEN s."tradingEnabled" THEN 'ON' ELSE 'PAUSED' END
  ),
  s."exitStrategy",
  s."minMarketCapUsd",
  s."maxMarketCapUsd",
  s."maxDeploymentPct",
  s."tier1MaxPct",
  s."tier2MaxPct",
  s."tier3MaxPct",
  s."tier4MaxPct",
  s."maxOpenPositions",
  COALESCE(NULLIF(s."ui" #>> '{evm,alloc}', '')::numeric, 50),
  COALESCE(NULLIF(s."ui" #>> '{evm,maxTok}', '')::numeric, 50),
  s."reservePct",
  s."minTradeUsd",
  s."autoTransferFromSavings",
  s."maxSlippageBps",
  s."maxPriceImpactPct",
  s."minLiquidityUsd",
  s."quoteMaxAgeMs",
  s."confirmTimeoutMs",
  s."maxExecutionAttempts",
  s."takeProfitPct",
  s."stopLossPct",
  s."trailingTriggerPct",
  s."trailingPartialSellPct",
  s."trailingDropPct",
  s."followTraderSells",
  s."firstBuyOnly",
  s."ui" -> 'evm',
  NOW(),
  'migration:user_mode_settings'
FROM "users" u
JOIN "strategy_settings" s ON s."id" = 1
ON CONFLICT ("userId", "mode") DO NOTHING;
