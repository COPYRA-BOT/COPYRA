-- Allow takeProfitPct = 0 (stop-loss-only mode). Previous CHECK required > 0,
-- which blocked the exec-throughput fix from applying SL-only defaults.

ALTER TABLE "strategy_settings" DROP CONSTRAINT IF EXISTS "strategy_settings_pct_bounds";

ALTER TABLE "strategy_settings"
  ADD CONSTRAINT "strategy_settings_pct_bounds" CHECK (
    "maxDeploymentPct" > 0 AND "maxDeploymentPct" <= 100
    AND "reservePct" >= 0 AND "reservePct" < 100
    AND "tier1MaxPct" > 0 AND "tier1MaxPct" <= 100
    AND "tier2MaxPct" > 0 AND "tier2MaxPct" <= 100
    AND "tier3MaxPct" > 0 AND "tier3MaxPct" <= 100
    AND "tier4MaxPct" > 0 AND "tier4MaxPct" <= 100
    AND "stopLossPct" > 0 AND "stopLossPct" < 100
    AND "takeProfitPct" >= 0
    AND "trailingDropPct" > 0 AND "trailingDropPct" < 100
    AND "trailingPartialSellPct" > 0 AND "trailingPartialSellPct" <= 100
    AND "maxSlippageBps" > 0 AND "maxSlippageBps" <= 5000
    AND "maxOpenPositions" > 0 AND "maxOpenPositions" <= 50
  );
