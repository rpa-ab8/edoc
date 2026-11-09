/**
 * Audit immutability — `npm run check:audit-immutability` (backend workspace).
 *
 * SECURITY_AUDIT.md M-1. CLAUDE.md: "Audit records are append-only. No update or delete path, for
 * anyone, ever." This checks the DATABASE enforces it, not just the application. Every attempt goes
 * straight at Postgres (Prisma client and raw SQL), the way a future bug, a raw query or someone
 * holding the app's credentials would:
 *   - UPDATE of any column, DELETE and TRUNCATE are refused;
 *   - the FK's ON DELETE SET NULL (a purged document) still works, and changes nothing else;
 *   - re-pointing documentId at another document is refused;
 *   - the test-cleanup path needs BOTH the database marked disposable AND the transaction opting in.
 *
 * DEV ONLY — needs a database marked with `npm run db:mark-disposable`.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { purgeTestAuditEvents } from "./_audit-purge.js";

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;
const ROLLBACK = "__probe_rollback__";

/**
 * Runs `op` inside a transaction that is ALWAYS rolled back, and reports whether Postgres refused it
 * as an append-only violation. Rolling back means a probe that wrongly succeeds (no trigger installed)
 * still changes nothing — so this check can never itself destroy audit history, not even TRUNCATE.
 */
async function refused(op: (tx: Tx) => Promise<unknown>): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await op(tx);
      throw new Error(ROLLBACK);
    });
    return false;
  } catch (err) {
    return !String(err).includes(ROLLBACK) && String(err).includes("append-only");
  }
}

const stamp = Date.now();
const PREFIX = "zz-aimm-";

const user = await prisma.user.create({
  data: { email: `${PREFIX}u-${stamp}@example.test`, passwordHash: "x", fullName: "Auditor", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ AuditImm ${stamp}`, industry: "test", createdByUserId: user.id, subfolderDepthLimit: 5 },
});
try {
  const dept = await prisma.department.create({
    data: { organizationId: org.id, name: "Ops", idPrefix: "OPS", subfolderDepthLimit: 5 },
  });
  const docType = await prisma.documentType.create({ data: { departmentId: dept.id, name: "Note", idCode: "NTE" } });
  const folder = await prisma.folder.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "F", parentFolderId: null, depth: 0 },
  });
  const makeDoc = (n: number) =>
    prisma.document.create({
      data: { organizationId: org.id, departmentId: dept.id, folderId: folder.id, documentTypeId: docType.id, documentRef: `OPS-NTE-2026-9${stamp % 10000}${n}` },
    });
  const docA = await makeDoc(1);
  const docB = await makeDoc(2);

  const event = (documentId: string | null, description: string) =>
    prisma.auditEvent.create({
      data: { organizationId: org.id, actorUserId: user.id, action: "view", documentId, departmentId: dept.id, targetDescription: description },
    });
  const e1 = await event(docA.id, "Viewed: original");
  const e2 = await event(null, "Config change");
  const snapshot = async (id: string) => JSON.stringify(await prisma.auditEvent.findUnique({ where: { id } }));
  const e1Before = await snapshot(e1.id);

  console.log("\n── rewriting history is refused ──");
  check("Prisma update of the description is refused", await refused((tx) => tx.auditEvent.update({ where: { id: e1.id }, data: { targetDescription: "Viewed: nothing to see" } })));
  check("Prisma update of the actor is refused", await refused((tx) => tx.auditEvent.update({ where: { id: e2.id }, data: { actorType: "system", actorUserId: null } })));
  check("Prisma updateMany of the timestamp is refused", await refused((tx) => tx.auditEvent.updateMany({ where: { organizationId: org.id }, data: { occurredAt: new Date(0) } })));
  check("raw SQL UPDATE is refused", await refused((tx) => tx.$executeRaw`UPDATE "audit_event" SET "isConfidential" = true WHERE "id" = ${e2.id}`));
  check("re-pointing documentId at another document is refused", await refused((tx) => tx.auditEvent.update({ where: { id: e1.id }, data: { documentId: docB.id } })));
  check("nulling documentId by hand while also editing is refused", await refused((tx) => tx.auditEvent.update({ where: { id: e1.id }, data: { documentId: null, targetDescription: "x" } })));
  check("…and the event is exactly as written", (await snapshot(e1.id)) === e1Before);

  console.log("\n── deleting history is refused ──");
  check("Prisma delete is refused", await refused((tx) => tx.auditEvent.delete({ where: { id: e2.id } })));
  check("Prisma deleteMany is refused", await refused((tx) => tx.auditEvent.deleteMany({ where: { organizationId: org.id } })));
  check("raw SQL DELETE is refused", await refused((tx) => tx.$executeRaw`DELETE FROM "audit_event" WHERE "id" = ${e2.id}`));
  check("TRUNCATE is refused", await refused((tx) => tx.$executeRawUnsafe(`TRUNCATE "audit_event"`)));
  check(
    "a session SET of the database mark does not unlock it",
    await refused(async (tx) => {
      await tx.$queryRaw`SELECT set_config('dms.audit_purge_allowed', 'on', true)`;
      await tx.auditEvent.delete({ where: { id: e2.id } });
    }),
  );
  // The deletes above ran on a database marked disposable but without the transaction opt-in — so the
  // mark alone unlocks nothing. (On production there is no mark, so the opt-in alone unlocks nothing.)
  const permittedWithoutOptIn = await prisma
    .$queryRaw<{ p: boolean }[]>`SELECT "audit_event_purge_permitted"() AS p`
    .then((r) => r[0]?.p)
    .catch(() => null);
  check("the purge gate is closed without the transaction opt-in", permittedWithoutOptIn === false, String(permittedWithoutOptIn));
  check("…and both events still exist", (await prisma.auditEvent.count({ where: { organizationId: org.id } })) === 2);

  console.log("\n── what must keep working ──");
  const created = await event(null, "Upload");
  check("control: inserting an event still works", created.id.length > 0);
  // A purge hard-deletes the document; the FK nulls documentId on its events — and nothing else.
  await prisma.document.delete({ where: { id: docA.id } });
  const after = await prisma.auditEvent.findUnique({ where: { id: e1.id } });
  const before = JSON.parse(e1Before) as Record<string, unknown>;
  check("control: purging a document nulls documentId on its events (ON DELETE SET NULL)", after?.documentId === null, String(after?.documentId));
  check(
    "…and leaves every other field untouched",
    after !== null && after.targetDescription === before.targetDescription && after.actorUserId === before.actorUserId && after.occurredAt.toISOString() === before.occurredAt,
  );

  console.log("\n── the test-cleanup path ──");
  check("the opt-in path deletes on a database marked disposable", (await purgeTestAuditEvents(prisma, { where: { id: created.id } })).count === 1);
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } }).catch((e) => check("cleanup", false, String(e)));
  await prisma.document.deleteMany({ where: { organizationId: org.id } });
  await prisma.folder.deleteMany({ where: { organizationId: org.id } });
  await prisma.documentType.deleteMany({ where: { department: { organizationId: org.id } } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
