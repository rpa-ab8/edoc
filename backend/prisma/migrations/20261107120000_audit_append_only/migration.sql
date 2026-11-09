-- SECURITY_AUDIT.md M-1 — the audit trail is append-only in the database, not just by convention.
--
-- CLAUDE.md hard rule: "Audit records are append-only. No update or delete path, for anyone, ever."
-- Until now only the application honoured that (lib/audit.ts exposes create only). This trigger makes
-- Postgres refuse every UPDATE, DELETE and TRUNCATE of "audit_event", whoever issues it: a future code
-- change, a raw query, a SQL injection, or a person with the application's credentials.
--
-- Exactly two things get through:
--
--  1. The one UPDATE the schema itself performs: audit_event.documentId is ON DELETE SET NULL, so when
--     a Department Admin purges a document Postgres nulls that column on its events — and nothing
--     else. An UPDATE that changes only documentId, from a value to NULL, is allowed; any other
--     change (or setting it to a different document) is refused.
--
--  2. Cleanup on a DISPOSABLE dev/test database, so the check-*.ts scripts can remove the fixtures
--     they created. It requires BOTH
--       - the database itself marked as disposable:  ALTER DATABASE <db> SET dms.audit_purge_allowed = 'on'
--         (read from pg_db_role_setting, so a session-level SET cannot fake it; changing it needs the
--         database owner), and
--       - the transaction opting in:  SELECT set_config('dms.audit_purge', 'on', true)
--     Production databases are never marked, so there no delete path exists at all. `npm run
--     db:mark-disposable` marks a dev database and refuses to run when NODE_ENV=production.
--
-- This protects against everything except someone holding the database *owner* role, who could drop
-- the trigger. The second half of M-1 — running the app as a role without UPDATE/DELETE on this table
-- and without DDL rights — closes that; see SECURITY_AUDIT.md.

CREATE FUNCTION "audit_event_purge_permitted"() RETURNS boolean AS $$
  SELECT coalesce(current_setting('dms.audit_purge', true), '') = 'on'
     AND EXISTS (
       SELECT 1
       FROM pg_db_role_setting s
       JOIN pg_database d ON d.oid = s.setdatabase
       WHERE d.datname = current_database()
         AND s.setrole = 0
         AND 'dms.audit_purge_allowed=on' = ANY (s.setconfig)
     );
$$ LANGUAGE sql STABLE;

CREATE FUNCTION "audit_event_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The FK's ON DELETE SET NULL: only documentId changes, and only to NULL.
    IF OLD."documentId" IS NOT NULL AND NEW."documentId" IS NULL
       AND (to_jsonb(NEW) - 'documentId') = (to_jsonb(OLD) - 'documentId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_event is append-only: UPDATE refused (event %)', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF "audit_event_purge_permitted"() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_event_append_only_row"
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();

CREATE TRIGGER "audit_event_append_only_truncate"
  BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_append_only"();
