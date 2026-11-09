/**
 * Marks the current (DEV) database as disposable — `npm run db:mark-disposable`.
 *
 * `audit_event` is append-only in the database (SECURITY_AUDIT.md M-1). On a database marked this way,
 * and only inside a transaction that explicitly opts in (scripts/_audit-purge.ts), the check-*.ts
 * scripts may delete the audit events of the fixtures they created. Never run this on production:
 * there the trail must have no delete path at all.
 *
 * Refuses when NODE_ENV=production or when DATABASE_URL does not point at this machine.
 * Undo with:  ALTER DATABASE <name> RESET dms.audit_purge_allowed;
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();

if (process.env.NODE_ENV === "production") {
  console.error("Refusing: NODE_ENV=production. The production audit trail must have no delete path.");
  process.exit(1);
}
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`Refusing: DATABASE_URL points at "${host || "?"}", not this machine. Only local dev databases may be marked.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
// Identifiers can't be bound parameters; the name comes from the server itself and is quoted.
await prisma.$executeRawUnsafe(`ALTER DATABASE "${db.replace(/"/g, '""')}" SET dms.audit_purge_allowed = 'on'`);
console.log(`Marked database "${db}" as disposable: test scripts may now clean up their audit-event fixtures.`);
await prisma.$disconnect();
