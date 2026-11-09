-- Rollback for 20261107120000_audit_append_only (SECURITY_AUDIT.md M-1).
--
--   npx dotenv -e ../.env -- prisma db execute --file prisma/migrations/20261107120000_audit_append_only/down.sql --schema prisma/schema.prisma
--   npx dotenv -e ../.env -- prisma migrate resolve --rolled-back 20261107120000_audit_append_only
--
-- Removes the database-level protection only; no data is touched. The application still never
-- updates or deletes audit events.

BEGIN;
DROP TRIGGER IF EXISTS "audit_event_append_only_truncate" ON "audit_event";
DROP TRIGGER IF EXISTS "audit_event_append_only_row" ON "audit_event";
DROP FUNCTION IF EXISTS "audit_event_append_only"();
DROP FUNCTION IF EXISTS "audit_event_purge_permitted"();
COMMIT;
