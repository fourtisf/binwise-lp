-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "poolId" TEXT,
    "positionId" TEXT,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "plan" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "result" TEXT,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Proposal_vaultId_status_idx" ON "Proposal"("vaultId", "status");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;
