-- Public portfolio: an owner can share a read-only page of the vault (off by default).
-- AlterTable
ALTER TABLE "Vault" ADD COLUMN     "publicAmounts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "publicId" TEXT,
ADD COLUMN     "publicOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Vault_publicId_key" ON "Vault"("publicId");
