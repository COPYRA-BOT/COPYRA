-- Per-account Telegram chat for BUY/SELL notifications only.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegramLinkedAt" TIMESTAMP(3);
