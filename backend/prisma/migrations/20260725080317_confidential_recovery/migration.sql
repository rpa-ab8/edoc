-- CreateEnum
CREATE TYPE "ConfidentialRecoveryStatus" AS ENUM ('pending', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "confidential_recovery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "newMemberUserId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "superAdminApprovedByUserId" TEXT,
    "deptAdminApprovedByUserId" TEXT,
    "status" "ConfidentialRecoveryStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "confidential_recovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "confidential_recovery_folderId_idx" ON "confidential_recovery"("folderId");

-- AddForeignKey
ALTER TABLE "confidential_recovery" ADD CONSTRAINT "confidential_recovery_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
