import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Test-fixture cleanup for audit events — the ONLY sanctioned delete of `audit_event`.
 *
 * The table is append-only in the database (migration 20261107120000_audit_append_only,
 * SECURITY_AUDIT.md M-1): a delete is refused unless the database is marked disposable
 * (`npm run db:mark-disposable`, never on production) AND the transaction opts in, which is what this
 * does. The check-*.ts scripts need it because an audit row pins its organization and actor user
 * (FK RESTRICT), so without it they couldn't remove their fixtures.
 */
export async function purgeTestAuditEvents(prisma: PrismaClient, args: Prisma.AuditEventDeleteManyArgs) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('dms.audit_purge', 'on', true)`;
      return tx.auditEvent.deleteMany(args);
    });
  } catch (err) {
    if (String(err).includes("append-only")) {
      console.error(
        "\nCould not clean up audit-event fixtures: this database is not marked disposable.\n" +
          "On a DEV database only, run once:  npm run db:mark-disposable\n",
      );
    }
    throw err;
  }
}
