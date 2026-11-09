-- CreateEnum
CREATE TYPE "TrashSource" AS ENUM ('user', 'auto_delete');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'system');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'auto_delete';
ALTER TYPE "AuditAction" ADD VALUE 'purge';
ALTER TYPE "AuditAction" ADD VALUE 'legal_hold_placed';
ALTER TYPE "AuditAction" ADD VALUE 'legal_hold_removed';
ALTER TYPE "AuditAction" ADD VALUE 'retention_change';

-- AlterTable
ALTER TABLE "audit_event" ADD COLUMN     "actorType" "AuditActorType" NOT NULL DEFAULT 'user',
ALTER COLUMN "actorUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "department" ADD COLUMN     "autoDeleteYears" INTEGER;

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "trashReason" TEXT,
ADD COLUMN     "trashSource" "TrashSource",
ADD COLUMN     "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- CreateTable
CREATE TABLE "legal_hold" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "documentId" TEXT,
    "folderId" TEXT,
    "reason" TEXT NOT NULL,
    "placedByUserId" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedByUserId" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_hold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_hold_organizationId_departmentId_idx" ON "legal_hold"("organizationId", "departmentId");

-- CreateIndex
CREATE INDEX "legal_hold_documentId_idx" ON "legal_hold"("documentId");

-- CreateIndex
CREATE INDEX "legal_hold_folderId_idx" ON "legal_hold"("folderId");

-- CreateIndex
CREATE INDEX "document_departmentId_status_uploadedAt_idx" ON "document"("departmentId", "status", "uploadedAt");

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_placedByUserId_fkey" FOREIGN KEY ("placedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Hand-written below this line (Prisma can't express these) ─────────────
-- Rollback: prisma/migrations/<this folder>/down.sql — see that file's header.

-- RET-2 backfill: a document's Upload Date is when it was first uploaded, i.e. its earliest
-- version. ADD COLUMN above stamped every existing row with "now"; replace that with the truth.
-- (createdAt is the fallback for a document with no version row — none should exist.)
UPDATE "document" d
SET "uploadedAt" = COALESCE(
  (SELECT MIN(v."createdAt") FROM "version" v WHERE v."documentId" = d."id"),
  d."createdAt"
);

-- RET-2: the Upload Date is immutable once set. Every application write path already leaves it
-- alone; this makes it a guarantee rather than a convention, because it is the clock auto-delete
-- runs on and a silent change would delete (or keep) documents on the wrong day.
CREATE FUNCTION "document_uploaded_at_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt" THEN
    RAISE EXCEPTION 'document.uploadedAt is immutable (document %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "document_uploaded_at_immutable"
  BEFORE UPDATE OF "uploadedAt" ON "document"
  FOR EACH ROW EXECUTE FUNCTION "document_uploaded_at_immutable"();

-- RET-1: whole years, positive. (null = off.)
ALTER TABLE "department" ADD CONSTRAINT "department_autoDeleteYears_positive"
  CHECK ("autoDeleteYears" IS NULL OR ("autoDeleteYears" >= 1 AND "autoDeleteYears" <= 100));

-- A hold targets exactly one thing: a document or a folder.
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_one_target"
  CHECK (("documentId" IS NULL) <> ("folderId" IS NULL));
-- A removal is recorded whole (who and when), or not at all.
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_removal_complete"
  CHECK (("removedAt" IS NULL) = ("removedByUserId" IS NULL));
-- A reason is mandatory (RET-5) — not just present, not blank.
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_reason_present"
  CHECK (length(btrim("reason")) > 0);
-- At most one *active* hold per target, so "place a hold" is naturally idempotent.
CREATE UNIQUE INDEX "legal_hold_active_document_key" ON "legal_hold"("documentId")
  WHERE "removedAt" IS NULL AND "documentId" IS NOT NULL;
CREATE UNIQUE INDEX "legal_hold_active_folder_key" ON "legal_hold"("folderId")
  WHERE "removedAt" IS NULL AND "folderId" IS NOT NULL;

-- A system event has no user; a user event always names one.
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_matches_type"
  CHECK (("actorType" = 'system') = ("actorUserId" IS NULL));

-- Organization time zone must be a zone Postgres knows, since it is used in AT TIME ZONE.
ALTER TABLE "organization" ADD CONSTRAINT "organization_timeZone_valid"
  CHECK ('epoch'::timestamptz AT TIME ZONE "timeZone" IS NOT NULL);

-- Change 8: the three new Department Admin rights go to every existing role that is already
-- Department-Admin-capable (members.change_role + configuration.edit_rules, the same test as
-- `hasDepartmentAdminCapability`). No other role gets them.
UPDATE "role"
SET "permissions" = "permissions" || '{"retention.manage_auto_delete": true, "retention.manage_legal_hold": true, "retention.view_upcoming_deletions": true}'::jsonb
WHERE ("permissions" ->> 'members.change_role') = 'true'
  AND ("permissions" ->> 'configuration.edit_rules') = 'true';
