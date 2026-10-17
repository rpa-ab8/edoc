-- AlterTable
ALTER TABLE "version" ADD COLUMN     "checksum" TEXT;

-- CreateIndex
CREATE INDEX "version_organizationId_checksum_idx" ON "version"("organizationId", "checksum");
