-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "feesReinvestedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramLinkCodeAt" TIMESTAMP(3);
