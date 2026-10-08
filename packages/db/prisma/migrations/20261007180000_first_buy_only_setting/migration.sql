-- Operator toggle: first-buy-only vs every qualifying buy (per account).
ALTER TABLE "strategy_settings"
  ADD COLUMN IF NOT EXISTS "firstBuyOnly" BOOLEAN NOT NULL DEFAULT true;
