-- CreateEnum
CREATE TYPE "ReferralLedgerKind" AS ENUM ('ACCRUAL', 'CLAIM', 'ADJUSTMENT');

-- AlterTable users: additive account fields
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleEmail" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleName" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referredById" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpSecretEnc" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);

-- Backfill unguessable referral codes for existing rows
UPDATE "users"
SET "referralCode" = substr(md5(random()::text || id || clock_timestamp()::text), 1, 18)
WHERE "referralCode" IS NULL;

ALTER TABLE "users" ALTER COLUMN "referralCode" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_googleSub_key" ON "users"("googleSub");
CREATE UNIQUE INDEX IF NOT EXISTS "users_referralCode_key" ON "users"("referralCode");
CREATE INDEX IF NOT EXISTS "users_referredById_idx" ON "users"("referredById");

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey"
    FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "user_wallet_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "family" "CustodyFamily" NOT NULL,
    "address" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_wallet_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_wallet_links_userId_family_key" ON "user_wallet_links"("userId", "family");
CREATE UNIQUE INDEX IF NOT EXISTS "user_wallet_links_family_address_key" ON "user_wallet_links"("family", "address");
CREATE INDEX IF NOT EXISTS "user_wallet_links_userId_idx" ON "user_wallet_links"("userId");

DO $$ BEGIN
  ALTER TABLE "user_wallet_links" ADD CONSTRAINT "user_wallet_links_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "transports" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "webauthn_credentials_userId_idx" ON "webauthn_credentials"("userId");
DO $$ BEGIN
  ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "recovery_codes_userId_idx" ON "recovery_codes"("userId");
DO $$ BEGIN
  ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "referral_ledger_entries" (
    "id" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "sourceUserId" TEXT,
    "tradeId" TEXT,
    "txHash" TEXT,
    "chain" "Chain" NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "kind" "ReferralLedgerKind" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referral_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "referral_ledger_entries_idempotencyKey_key" ON "referral_ledger_entries"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "referral_ledger_entries_beneficiaryUserId_kind_idx" ON "referral_ledger_entries"("beneficiaryUserId", "kind");
CREATE INDEX IF NOT EXISTS "referral_ledger_entries_sourceUserId_idx" ON "referral_ledger_entries"("sourceUserId");
DO $$ BEGIN
  ALTER TABLE "referral_ledger_entries" ADD CONSTRAINT "referral_ledger_entries_beneficiaryUserId_fkey"
    FOREIGN KEY ("beneficiaryUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "referral_ledger_entries" ADD CONSTRAINT "referral_ledger_entries_sourceUserId_fkey"
    FOREIGN KEY ("sourceUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "account_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "account_audit_logs_userId_createdAt_idx" ON "account_audit_logs"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "account_audit_logs_action_createdAt_idx" ON "account_audit_logs"("action", "createdAt");
DO $$ BEGIN
  ALTER TABLE "account_audit_logs" ADD CONSTRAINT "account_audit_logs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
