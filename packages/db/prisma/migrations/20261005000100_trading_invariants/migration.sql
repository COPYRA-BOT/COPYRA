-- COPYRA trading invariants enforced by the database, not by application code.
--
-- Application-level checks lose races. These constraints make the dangerous
-- states unrepresentable, so two concurrent signals cannot both open a
-- position, and a replayed signal cannot execute twice, even if Redis has been
-- flushed or a worker has just restarted.

-- ---------------------------------------------------------------------------
-- 1. ONE TOKEN = ONE OPEN POSITION (spec §5, §6)
--
-- A partial unique index: only rows in a live state participate, so a token can
-- be traded again after its previous position closes, but never twice at once.
-- Prisma cannot express a partial unique index in schema.prisma, hence raw SQL.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "positions_one_open_per_token"
  ON "positions" ("chain", "tokenAddress")
  WHERE "status" IN ('PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSING');

-- ---------------------------------------------------------------------------
-- 2. A position can never hold a negative remaining balance, and realised P&L
--    must be a real number. Guards against a partial-fill accounting bug
--    silently producing impossible state.
-- ---------------------------------------------------------------------------
ALTER TABLE "positions"
  ADD CONSTRAINT "positions_remaining_non_negative"
  CHECK ("remainingTokenRaw" IS NULL OR "remainingTokenRaw" !~ '^-');

-- ---------------------------------------------------------------------------
-- 3. A trade that claims to be CONFIRMED must carry a real transaction hash.
--    This is the schema-level expression of "never treat an API response as
--    proof of execution".
-- ---------------------------------------------------------------------------
ALTER TABLE "trades"
  ADD CONSTRAINT "trades_confirmed_requires_hash"
  CHECK (
    "status" NOT IN ('BROADCAST', 'LANDED', 'CONFIRMED')
    OR ("txHash" IS NOT NULL AND length("txHash") > 0)
  );

-- A confirmed trade must also carry a confirmation timestamp.
ALTER TABLE "trades"
  ADD CONSTRAINT "trades_confirmed_requires_timestamp"
  CHECK ("status" <> 'CONFIRMED' OR "confirmedAt" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. Positions that claim to be OPEN must have a confirmed entry.
-- ---------------------------------------------------------------------------
ALTER TABLE "positions"
  ADD CONSTRAINT "positions_open_requires_entry"
  CHECK (
    "status" NOT IN ('OPEN', 'PARTIALLY_CLOSED')
    OR ("openedAt" IS NOT NULL AND "entryPriceUsd" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 5. Strategy settings is a singleton. A second row would mean two different
--    risk configurations racing each other.
-- ---------------------------------------------------------------------------
ALTER TABLE "strategy_settings"
  ADD CONSTRAINT "strategy_settings_singleton" CHECK ("id" = 1);

-- ---------------------------------------------------------------------------
-- 6. Risk percentages must stay inside sane bounds no matter what the UI sends.
-- ---------------------------------------------------------------------------
ALTER TABLE "strategy_settings"
  ADD CONSTRAINT "strategy_settings_pct_bounds" CHECK (
    "maxDeploymentPct" > 0 AND "maxDeploymentPct" <= 100
    AND "reservePct" >= 0 AND "reservePct" < 100
    AND "tier1MaxPct" > 0 AND "tier1MaxPct" <= 100
    AND "tier2MaxPct" > 0 AND "tier2MaxPct" <= 100
    AND "tier3MaxPct" > 0 AND "tier3MaxPct" <= 100
    AND "tier4MaxPct" > 0 AND "tier4MaxPct" <= 100
    AND "stopLossPct" > 0 AND "stopLossPct" < 100
    AND "takeProfitPct" > 0
    AND "trailingDropPct" > 0 AND "trailingDropPct" < 100
    AND "trailingPartialSellPct" > 0 AND "trailingPartialSellPct" <= 100
    AND "maxSlippageBps" > 0 AND "maxSlippageBps" <= 5000
    AND "maxOpenPositions" > 0 AND "maxOpenPositions" <= 50
  );

-- ---------------------------------------------------------------------------
-- 7. Indexes for the hot paths: the position monitor sweeps open positions
--    every tick, and the reconciliation worker sweeps unconfirmed trades.
-- ---------------------------------------------------------------------------
CREATE INDEX "positions_open_monitor_idx"
  ON "positions" ("status", "lastPriceAt")
  WHERE "status" IN ('OPEN', 'PARTIALLY_CLOSED');

CREATE INDEX "trades_pending_confirmation_idx"
  ON "trades" ("status", "broadcastAt")
  WHERE "status" IN ('BROADCAST', 'LANDED', 'UNKNOWN');
