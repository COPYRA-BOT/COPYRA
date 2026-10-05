-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC', 'POLYGON', 'OPTIMISM', 'ARC', 'ROBINHOOD', 'HYPERLIQUID', 'TRON');

-- CreateEnum
CREATE TYPE "TxClassification" AS ENUM ('BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'AIRDROP', 'STAKE', 'UNSTAKE', 'LP_ADD', 'LP_REMOVE', 'CLAIM', 'BRIDGE', 'MIGRATION', 'NFT', 'APPROVAL', 'CONTRACT_DEPLOY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('DETECTED', 'QUALIFIED', 'SKIPPED', 'EXECUTING', 'EXECUTED', 'FAILED', 'BLOCKED_NO_SIGNER', 'BLOCKED_DISABLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSED', 'OPEN_FAILED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeReason" AS ENUM ('COPY', 'TAKE_PROFIT', 'STOP_LOSS', 'TRAILING_STOP', 'TRADER_SOLD', 'MANUAL', 'EMERGENCY_STOP');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('BUILDING', 'SIGNED', 'BROADCAST', 'LANDED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'DROPPED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExitStrategy" AS ENUM ('MANUAL', 'TRAILING');

-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('MARKET_CAP_TOO_HIGH', 'MARKET_CAP_TOO_LOW', 'NOT_A_BUY', 'NO_QUOTE_CURRENCY_SPENT', 'IS_AIRDROP', 'IS_TRANSFER', 'IS_STAKING', 'IS_LP', 'IS_CLAIM', 'IS_BRIDGE', 'IS_MIGRATION', 'IS_SELL', 'NOT_TRADABLE', 'INSUFFICIENT_LIQUIDITY', 'PRICE_IMPACT_TOO_HIGH', 'SLIPPAGE_TOO_HIGH', 'BLACKLISTED', 'NOT_FIRST_BUY', 'POSITION_ALREADY_OPEN', 'MAX_POSITIONS_REACHED', 'INSUFFICIENT_BALANCE', 'BELOW_MIN_TRADE_SIZE', 'RESERVE_PROTECTED', 'MAX_DEPLOYMENT_REACHED', 'DUPLICATE_SIGNAL', 'TRADER_DISABLED', 'CHAIN_NOT_EXECUTABLE', 'QUOTE_FAILED', 'QUOTE_STALE', 'TOKEN_METADATA_UNAVAILABLE', 'RPC_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "BalanceBucket" AS ENUM ('TRADING', 'SAVINGS');

-- CreateEnum
CREATE TYPE "SystemEventLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DriftKind" AS ENUM ('BALANCE_MISMATCH', 'POSITION_MISSING_ONCHAIN', 'POSITION_MISSING_IN_DB', 'TOKEN_BALANCE_MISMATCH', 'TX_STATUS_MISMATCH', 'REALIZED_PNL_MISMATCH');

-- CreateEnum
CREATE TYPE "DriftResolution" AS ENUM ('UNRESOLVED', 'RECONCILED_FROM_CHAIN', 'MANUALLY_REVIEWED', 'IGNORED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "label" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traders" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" DECIMAL(6,3) NOT NULL DEFAULT 1.0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3),
    "lastSignature" TEXT,

    CONSTRAINT "traders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "decimals" INTEGER,
    "priceUsd" DECIMAL(40,18),
    "marketCapUsd" DECIMAL(30,4),
    "fdvUsd" DECIMAL(30,4),
    "liquidityUsd" DECIMAL(30,4),
    "volume24hUsd" DECIMAL(30,4),
    "marketSource" TEXT,
    "marketUpdatedAt" TIMESTAMP(3),
    "blacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklistReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_first_buys" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "firstTraderId" TEXT NOT NULL,
    "firstSignalId" TEXT,
    "firstSourceTx" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlatedBuys" INTEGER NOT NULL DEFAULT 0,
    "lastCorrelatedAt" TIMESTAMP(3),

    CONSTRAINT "token_first_buys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detected_transactions" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "txHash" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "blockTime" TIMESTAMP(3),
    "classification" "TxClassification" NOT NULL,
    "venue" TEXT,
    "tokenInAddress" TEXT,
    "tokenInSymbol" TEXT,
    "tokenInDecimals" INTEGER,
    "tokenInAmountRaw" TEXT,
    "tokenOutAddress" TEXT,
    "tokenOutSymbol" TEXT,
    "tokenOutDecimals" INTEGER,
    "tokenOutAmountRaw" TEXT,
    "feeRaw" TEXT,
    "rawDecoded" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decodedAt" TIMESTAMP(3),
    "detectLatencyMs" INTEGER,
    "decodeLatencyMs" INTEGER,

    CONSTRAINT "detected_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_signatures" (
    "chain" "Chain" NOT NULL,
    "signature" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "processed_signatures_pkey" PRIMARY KEY ("chain","signature")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "traderId" TEXT NOT NULL,
    "tokenId" TEXT,
    "tokenAddress" TEXT NOT NULL,
    "detectionId" TEXT,
    "sourceTxHash" TEXT NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'DETECTED',
    "skipReason" "SkipReason",
    "skipDetail" TEXT,
    "signalStrength" DECIMAL(6,3) NOT NULL DEFAULT 1.0,
    "marketCapUsdAtSignal" DECIMAL(30,4),
    "liquidityUsdAtSignal" DECIMAL(30,4),
    "priceUsdAtSignal" DECIMAL(40,18),
    "plannedSizeQuote" DECIMAL(40,18),
    "plannedSizeUsd" DECIMAL(30,4),
    "sizingBasis" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decodedAt" TIMESTAMP(3),
    "qualifiedAt" TIMESTAMP(3),
    "riskCheckedAt" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3),
    "builtAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "broadcastAt" TIMESTAMP(3),
    "landedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "detectToBroadcastMs" INTEGER,
    "detectToConfirmMs" INTEGER,
    "positionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "status" "PositionStatus" NOT NULL DEFAULT 'PENDING_OPEN',
    "quoteAsset" TEXT NOT NULL,
    "quoteAssetSymbol" TEXT NOT NULL,
    "exitStrategy" "ExitStrategy" NOT NULL,
    "requestedQuoteRaw" TEXT,
    "actualQuoteRaw" TEXT,
    "tokenAmountRaw" TEXT,
    "remainingTokenRaw" TEXT,
    "entryPriceUsd" DECIMAL(40,18),
    "entryQuotePriceUsd" DECIMAL(30,10),
    "entryValueUsd" DECIMAL(30,4),
    "entryMarketCapUsd" DECIMAL(30,4),
    "entryLiquidityUsd" DECIMAL(30,4),
    "entrySlippagePct" DECIMAL(10,6),
    "entryPriceImpactPct" DECIMAL(10,6),
    "stopLossPriceUsd" DECIMAL(40,18),
    "takeProfitPriceUsd" DECIMAL(40,18),
    "highestPriceUsd" DECIMAL(40,18),
    "trailingActive" BOOLEAN NOT NULL DEFAULT false,
    "trailingActivatedAt" TIMESTAMP(3),
    "trailingStopPriceUsd" DECIMAL(40,18),
    "partialTakeProfitDone" BOOLEAN NOT NULL DEFAULT false,
    "lastPriceUsd" DECIMAL(40,18),
    "lastPriceAt" TIMESTAMP(3),
    "unrealizedPnlQuote" DECIMAL(40,18),
    "unrealizedPnlUsd" DECIMAL(30,4),
    "unrealizedPnlPct" DECIMAL(12,6),
    "realizedPnlQuote" DECIMAL(40,18) NOT NULL DEFAULT 0,
    "realizedPnlUsd" DECIMAL(30,4) NOT NULL DEFAULT 0,
    "feesQuote" DECIMAL(40,18) NOT NULL DEFAULT 0,
    "correlatedTraders" INTEGER NOT NULL DEFAULT 1,
    "signalStrength" DECIMAL(6,3) NOT NULL DEFAULT 1.0,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" "TradeReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "positionId" TEXT,
    "signalId" TEXT,
    "chain" "Chain" NOT NULL,
    "side" "TradeSide" NOT NULL,
    "reason" "TradeReason" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "tokenDecimals" INTEGER,
    "quoteAsset" TEXT NOT NULL,
    "quoteAssetSymbol" TEXT NOT NULL,
    "quoteDecimals" INTEGER,
    "status" "TxStatus" NOT NULL DEFAULT 'BUILDING',
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "explorerUrl" TEXT,
    "requestedAmountRaw" TEXT NOT NULL,
    "quotedAmountRaw" TEXT,
    "actualAmountRaw" TEXT,
    "fillRatio" DECIMAL(10,6),
    "executionPriceUsd" DECIMAL(40,18),
    "valueUsd" DECIMAL(30,4),
    "quoteAssetPriceUsd" DECIMAL(30,10),
    "requestedSlippageBps" INTEGER,
    "realizedSlippagePct" DECIMAL(12,6),
    "priceImpactPct" DECIMAL(12,6),
    "networkFeeRaw" TEXT,
    "priorityFeeRaw" TEXT,
    "feeUsd" DECIMAL(20,6),
    "routeProvider" TEXT,
    "routeSummary" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptLog" JSONB,
    "sourceDetectedAt" TIMESTAMP(3),
    "decodedAt" TIMESTAMP(3),
    "qualifiedAt" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3),
    "builtAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "broadcastAt" TIMESTAMP(3),
    "landedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "quoteLatencyMs" INTEGER,
    "buildLatencyMs" INTEGER,
    "signLatencyMs" INTEGER,
    "broadcastLatencyMs" INTEGER,
    "confirmLatencyMs" INTEGER,
    "totalLatencyMs" INTEGER,
    "blockhash" TEXT,
    "lastValidBlockHeight" BIGINT,
    "nonce" INTEGER,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_balances" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "bucket" "BalanceBucket" NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "priceUsd" DECIMAL(30,10),
    "valueUsd" DECIMAL(30,4),
    "readAtBlock" BIGINT,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "fromBucket" "BalanceBucket" NOT NULL,
    "toBucket" "BalanceBucket" NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'BUILDING',
    "txHash" TEXT,
    "explorerUrl" TEXT,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emergencyStop" BOOLEAN NOT NULL DEFAULT false,
    "emergencyStopReason" TEXT,
    "emergencyStopAt" TIMESTAMP(3),
    "exitStrategy" "ExitStrategy" NOT NULL DEFAULT 'MANUAL',
    "minMarketCapUsd" DECIMAL(30,4) NOT NULL DEFAULT 1000000,
    "maxMarketCapUsd" DECIMAL(30,4) NOT NULL DEFAULT 20000000,
    "maxDeploymentPct" DECIMAL(6,3) NOT NULL DEFAULT 80,
    "tier1MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 20,
    "tier2MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 30,
    "tier3MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 40,
    "tier4MaxPct" DECIMAL(6,3) NOT NULL DEFAULT 50,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 5,
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
    "enabledChains" "Chain"[] DEFAULT ARRAY['SOLANA', 'BASE']::"Chain"[],
    "pnlResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "strategy_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_events" (
    "id" TEXT NOT NULL,
    "level" "SystemEventLevel" NOT NULL,
    "component" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "chain" "Chain",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rpc_health" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "endpoint" TEXT NOT NULL,
    "healthy" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "blockHeight" BIGINT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rpc_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "name" TEXT NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "drift_flags" (
    "id" TEXT NOT NULL,
    "kind" "DriftKind" NOT NULL,
    "chain" "Chain" NOT NULL,
    "positionId" TEXT,
    "subject" TEXT NOT NULL,
    "dbValue" TEXT,
    "chainValue" TEXT,
    "detail" JSONB,
    "resolution" "DriftResolution" NOT NULL DEFAULT 'UNRESOLVED',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "drift_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tradeId" TEXT,
    "positionId" TEXT,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_address_key" ON "users"("address");

-- CreateIndex
CREATE UNIQUE INDEX "auth_nonces_nonce_key" ON "auth_nonces"("nonce");

-- CreateIndex
CREATE INDEX "auth_nonces_address_usedAt_idx" ON "auth_nonces"("address", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "traders_enabled_idx" ON "traders"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "traders_chain_address_key" ON "traders"("chain", "address");

-- CreateIndex
CREATE INDEX "tokens_chain_marketUpdatedAt_idx" ON "tokens"("chain", "marketUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_chain_address_key" ON "tokens"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "token_first_buys_tokenId_key" ON "token_first_buys"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "token_first_buys_chain_tokenAddress_key" ON "token_first_buys"("chain", "tokenAddress");

-- CreateIndex
CREATE INDEX "detected_transactions_chain_classification_observedAt_idx" ON "detected_transactions"("chain", "classification", "observedAt");

-- CreateIndex
CREATE INDEX "detected_transactions_traderId_observedAt_idx" ON "detected_transactions"("traderId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "detected_transactions_chain_txHash_traderId_key" ON "detected_transactions"("chain", "txHash", "traderId");

-- CreateIndex
CREATE UNIQUE INDEX "signals_detectionId_key" ON "signals"("detectionId");

-- CreateIndex
CREATE INDEX "signals_status_createdAt_idx" ON "signals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "signals_chain_tokenAddress_idx" ON "signals"("chain", "tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "signals_chain_sourceTxHash_traderId_key" ON "signals"("chain", "sourceTxHash", "traderId");

-- CreateIndex
CREATE INDEX "positions_status_chain_idx" ON "positions"("status", "chain");

-- CreateIndex
CREATE INDEX "positions_chain_tokenAddress_status_idx" ON "positions"("chain", "tokenAddress", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trades_idempotencyKey_key" ON "trades"("idempotencyKey");

-- CreateIndex
CREATE INDEX "trades_status_createdAt_idx" ON "trades"("status", "createdAt");

-- CreateIndex
CREATE INDEX "trades_positionId_idx" ON "trades"("positionId");

-- CreateIndex
CREATE INDEX "trades_chain_txHash_idx" ON "trades"("chain", "txHash");

-- CreateIndex
CREATE INDEX "wallet_balances_chain_address_idx" ON "wallet_balances"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_balances_chain_address_bucket_assetAddress_key" ON "wallet_balances"("chain", "address", "bucket", "assetAddress");

-- CreateIndex
CREATE INDEX "transfers_status_idx" ON "transfers"("status");

-- CreateIndex
CREATE INDEX "system_events_level_createdAt_idx" ON "system_events"("level", "createdAt");

-- CreateIndex
CREATE INDEX "system_events_component_createdAt_idx" ON "system_events"("component", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "rpc_health_chain_endpoint_key" ON "rpc_health"("chain", "endpoint");

-- CreateIndex
CREATE INDEX "drift_flags_resolution_detectedAt_idx" ON "drift_flags"("resolution", "detectedAt");

-- CreateIndex
CREATE INDEX "notification_logs_kind_createdAt_idx" ON "notification_logs"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_first_buys" ADD CONSTRAINT "token_first_buys_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detected_transactions" ADD CONSTRAINT "detected_transactions_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "traders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "traders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_detectionId_fkey" FOREIGN KEY ("detectionId") REFERENCES "detected_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_flags" ADD CONSTRAINT "drift_flags_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
