-- Per-user account isolation: traders / signals / positions / trades / notifications
-- are owned by a dashboard User and never shared across wallets.

-- 1) Traders ---------------------------------------------------------------
ALTER TABLE "traders" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- Drop orphan / previously-global traders (no safe owner mapping).
DELETE FROM "traders" WHERE "userId" IS NULL;

ALTER TABLE "traders" ALTER COLUMN "userId" SET NOT NULL;

DROP INDEX IF EXISTS "traders_chain_address_key";
CREATE UNIQUE INDEX IF NOT EXISTS "traders_userId_chain_address_key" ON "traders"("userId", "chain", "address");
CREATE INDEX IF NOT EXISTS "traders_userId_enabled_idx" ON "traders"("userId", "enabled");

DO $$ BEGIN
  ALTER TABLE "traders" ADD CONSTRAINT "traders_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) Signals ---------------------------------------------------------------
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "userId" TEXT;

UPDATE "signals" s
SET "userId" = t."userId"
FROM "traders" t
WHERE s."traderId" = t."id" AND s."userId" IS NULL;

DELETE FROM "signals" WHERE "userId" IS NULL;

ALTER TABLE "signals" ALTER COLUMN "userId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "signals_userId_createdAt_idx" ON "signals"("userId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "signals" ADD CONSTRAINT "signals_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3) Positions -------------------------------------------------------------
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- Best-effort: inherit owner from the earliest linked signal.
UPDATE "positions" p
SET "userId" = s."userId"
FROM "signals" s
WHERE s."positionId" = p."id" AND p."userId" IS NULL;

DELETE FROM "positions" WHERE "userId" IS NULL;

ALTER TABLE "positions" ALTER COLUMN "userId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "positions_userId_status_idx" ON "positions"("userId", "status");
CREATE INDEX IF NOT EXISTS "positions_userId_chain_tokenAddress_status_idx"
  ON "positions"("userId", "chain", "tokenAddress", "status");

DO $$ BEGIN
  ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4) Trades ----------------------------------------------------------------
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "userId" TEXT;

UPDATE "trades" t
SET "userId" = p."userId"
FROM "positions" p
WHERE t."positionId" = p."id" AND t."userId" IS NULL;

UPDATE "trades" t
SET "userId" = s."userId"
FROM "signals" s
WHERE t."signalId" = s."id" AND t."userId" IS NULL;

DELETE FROM "trades" WHERE "userId" IS NULL;

ALTER TABLE "trades" ALTER COLUMN "userId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "trades_userId_createdAt_idx" ON "trades"("userId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "trades" ADD CONSTRAINT "trades_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5) Notifications ---------------------------------------------------------
ALTER TABLE "notification_logs" ADD COLUMN IF NOT EXISTS "userId" TEXT;

UPDATE "notification_logs" n
SET "userId" = t."userId"
FROM "trades" t
WHERE n."tradeId" = t."id" AND n."userId" IS NULL;

UPDATE "notification_logs" n
SET "userId" = p."userId"
FROM "positions" p
WHERE n."positionId" = p."id" AND n."userId" IS NULL;

-- System noise stays userId=null and is hidden from per-account dashboards.
CREATE INDEX IF NOT EXISTS "notification_logs_userId_createdAt_idx"
  ON "notification_logs"("userId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
