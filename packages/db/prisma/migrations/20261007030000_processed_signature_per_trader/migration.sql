-- Per-trader processed-signature keys so two accounts can copy the same
-- on-chain wallet independently (no shared global signature lock).

TRUNCATE TABLE "processed_signatures";

ALTER TABLE "processed_signatures" ADD COLUMN IF NOT EXISTS "traderId" TEXT;

ALTER TABLE "processed_signatures" DROP CONSTRAINT IF EXISTS "processed_signatures_pkey";

UPDATE "processed_signatures" SET "traderId" = '' WHERE "traderId" IS NULL;
ALTER TABLE "processed_signatures" ALTER COLUMN "traderId" SET NOT NULL;

ALTER TABLE "processed_signatures"
  ADD CONSTRAINT "processed_signatures_pkey"
  PRIMARY KEY ("chain", "signature", "traderId");

CREATE INDEX IF NOT EXISTS "processed_signatures_traderId_idx"
  ON "processed_signatures"("traderId");
