-- AlterTable
ALTER TABLE "PoolSnapshot" ADD COLUMN     "feeRatePct" DOUBLE PRECISION,
ADD COLUMN     "dynamicFeePct" DOUBLE PRECISION,
ADD COLUMN     "feeYieldDailyPct" DOUBLE PRECISION,
ADD COLUMN     "farmAprPct" DOUBLE PRECISION,
ADD COLUMN     "scoringVolume" DOUBLE PRECISION,
ADD COLUMN     "volumeSpike" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "efficiency" DOUBLE PRECISION,
ADD COLUMN     "change24hPct" DOUBLE PRECISION,
ADD COLUMN     "aboveEma50" BOOLEAN,
ADD COLUMN     "riskFlags" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "ParamSet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "params" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "metrics" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ParamSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenEvent" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParamSet_active_idx" ON "ParamSet"("active");

-- CreateIndex
CREATE INDEX "TokenEvent_mint_at_idx" ON "TokenEvent"("mint", "at");
