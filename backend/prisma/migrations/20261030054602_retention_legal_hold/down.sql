-- Rollback for 20261030054602_retention_legal_hold.
--
--   npx dotenv -e ../.env -- prisma db execute --file prisma/migrations/20261030054602_retention_legal_hold/down.sql --schema prisma/schema.prisma
--   npx dotenv -e ../.env -- prisma migrate resolve --rolled-back 20261030054602_retention_legal_hold
--   then check out the previous schema.prisma and run `prisma generate`.
--
-- NOT fully reversible, by design:
--  * Postgres cannot drop enum values, so the five new "AuditAction" values stay (unused). Audit rows
--    that used them are kept — the audit trail is append-only — which also means this script REFUSES
--    to run while any system-actor audit row exists, because the old schema can't represent one.
--  * Legal holds, auto-delete periods, trash reasons and organization time zones are discarded.
--  * Documents already permanently purged by the new jobs are gone; a rollback can't bring them back.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "audit_event" WHERE "actorUserId" IS NULL) THEN
    RAISE EXCEPTION 'System-actor audit events exist; the previous schema requires a user on every event. Rolling back would mean deleting audit records, which is never done.';
  END IF;
END $$;

UPDATE "role"
SET "permissions" = "permissions" - 'retention.manage_auto_delete' - 'retention.manage_legal_hold' - 'retention.view_upcoming_deletions';

ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_timeZone_valid";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "timeZone";

ALTER TABLE "audit_event" DROP CONSTRAINT IF EXISTS "audit_event_actor_matches_type";
ALTER TABLE "audit_event" DROP COLUMN IF EXISTS "actorType";
ALTER TABLE "audit_event" ALTER COLUMN "actorUserId" SET NOT NULL;

DROP TABLE IF EXISTS "legal_hold";

ALTER TABLE "department" DROP CONSTRAINT IF EXISTS "department_autoDeleteYears_positive";
ALTER TABLE "department" DROP COLUMN IF EXISTS "autoDeleteYears";

DROP TRIGGER IF EXISTS "document_uploaded_at_immutable" ON "document";
DROP FUNCTION IF EXISTS "document_uploaded_at_immutable"();
DROP INDEX IF EXISTS "document_departmentId_status_uploadedAt_idx";
ALTER TABLE "document" DROP COLUMN IF EXISTS "uploadedAt";
ALTER TABLE "document" DROP COLUMN IF EXISTS "trashSource";
ALTER TABLE "document" DROP COLUMN IF EXISTS "trashReason";

DROP TYPE IF EXISTS "TrashSource";
DROP TYPE IF EXISTS "AuditActorType";

COMMIT;
