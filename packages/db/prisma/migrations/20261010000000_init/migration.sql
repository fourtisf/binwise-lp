-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VaultMode" AS ENUM ('paper', 'live');

-- CreateEnum
CREATE TYPE "VaultStatus" AS ENUM ('running', 'paused');

-- CreateEnum
CREATE TYPE "RiskProfile" AS ENUM ('conservative', 'balanced', 'aggressive');

-- CreateEnum
CREATE TYPE "LiquidityShape" AS ENUM ('spot', 'curve', 'bidask');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "DecisionType" AS ENUM ('scan', 'deploy', 'rebalance', 'exit', 'compound', 'hold', 'skip');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('simulated', 'sent', 'confirmed', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vault" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "VaultMode" NOT NULL DEFAULT 'paper',
    "status" "VaultStatus" NOT NULL DEFAULT 'running',
    "agentPubkey" TEXT,
    "encSecret" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "profile" "RiskProfile" NOT NULL DEFAULT 'balanced',
    "maxAllocPct" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "minMcap" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "trendExitPct" DOUBLE PRECISION NOT NULL DEFAULT -12,
    "dailyStopPct" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "weights" JSONB NOT NULL,
    "toggles" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pool" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "tokenA" TEXT NOT NULL,
    "tokenB" TEXT NOT NULL,
    "binStep" INTEGER NOT NULL,
    "baseFee" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolSnapshot" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tvl" DOUBLE PRECISION NOT NULL,
    "volume24h" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "volatility" DOUBLE PRECISION NOT NULL,
    "trend7d" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "scoreBreakdown" JSONB NOT NULL,

    CONSTRAINT "PoolSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "address" TEXT,
    "lowerBin" INTEGER NOT NULL,
    "upperBin" INTEGER NOT NULL,
    "shape" "LiquidityShape" NOT NULL,
    "entryAmountA" DOUBLE PRECISION NOT NULL,
    "entryAmountB" DOUBLE PRECISION NOT NULL,
    "entryPriceA" DOUBLE PRECISION NOT NULL,
    "entryPriceB" DOUBLE PRECISION NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "status" "PositionStatus" NOT NULL DEFAULT 'open',

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "poolId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "DecisionType" NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "txSig" TEXT,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tx" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "sig" TEXT,
    "status" "TxStatus" NOT NULL,
    "feeLamports" BIGINT,
    "simulated" BOOLEAN NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultSnapshot" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" DOUBLE PRECISION NOT NULL,
    "holdValue" DOUBLE PRECISION NOT NULL,
    "feesTotal" DOUBLE PRECISION NOT NULL,
    "netVsHold" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "VaultSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_wallet_key" ON "User"("wallet");

-- CreateIndex
CREATE INDEX "Vault_userId_idx" ON "Vault"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_vaultId_key" ON "Strategy"("vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "Pool_address_key" ON "Pool"("address");

-- CreateIndex
CREATE INDEX "PoolSnapshot_poolId_ts_idx" ON "PoolSnapshot"("poolId", "ts");

-- CreateIndex
CREATE INDEX "PoolSnapshot_ts_idx" ON "PoolSnapshot"("ts");

-- CreateIndex
CREATE INDEX "Position_vaultId_status_idx" ON "Position"("vaultId", "status");

-- CreateIndex
CREATE INDEX "Decision_vaultId_ts_idx" ON "Decision"("vaultId", "ts");

-- CreateIndex
CREATE INDEX "Decision_vaultId_type_ts_idx" ON "Decision"("vaultId", "type", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Tx_sig_key" ON "Tx"("sig");

-- CreateIndex
CREATE INDEX "Tx_decisionId_idx" ON "Tx"("decisionId");

-- CreateIndex
CREATE INDEX "VaultSnapshot_vaultId_ts_idx" ON "VaultSnapshot"("vaultId", "ts");

-- AddForeignKey
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolSnapshot" ADD CONSTRAINT "PoolSnapshot_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tx" ADD CONSTRAINT "Tx_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultSnapshot" ADD CONSTRAINT "VaultSnapshot_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

