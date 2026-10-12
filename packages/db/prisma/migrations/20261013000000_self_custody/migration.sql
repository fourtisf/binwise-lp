-- Self-custody: a live vault can keep its funds in the owner's own wallet (no key at Binwise).
-- CreateEnum
CREATE TYPE "VaultCustody" AS ENUM ('agent', 'wallet');

-- AlterTable
ALTER TABLE "Vault" ADD COLUMN     "custody" "VaultCustody" NOT NULL DEFAULT 'agent';
