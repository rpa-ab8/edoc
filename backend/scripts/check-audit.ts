/**
 * Audit-viewer checks — `npm run check:audit` (backend workspace).
 *
 * Covers Module 12 (AUD-2/4/5): combinable filters (actor / action / document / date), confidential
 * segregation (hidden without `view_confidential_audit`), and export gated by `export_audit`. DB only.
 * Point it at a development environment.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import * as audit from "../src/modules/audit/audit.service.js";
import { AuditError } from "../src/modules/audit/audit.service.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const deps = { prisma };
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + extra}`);
  if (ok) pass++;
  else fail++;
}
async function expectError(label: string, code: string, run: () => Promise<unknown>) {
  try {
    await run();
    check(label, false, "no error thrown");
  } catch (err) {
    const actual = err instanceof AuditError ? err.code : String(err);
    check(label, actual === code, `expected ${code}, got ${actual}`);
  }
}

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });
const dept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Audit", idPrefix: "ZZA", subfolderDepthLimit: 5 },
});

const auditorRole = await prisma.role.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Auditor", permissions: permissionMapFrom(["audit.view_audit"]) as object },
});
const adminRole = await prisma.role.create({
  data: {
    organizationId: org.id, departmentId: dept.id, name: "Compliance",
    permissions: permissionMapFrom(["audit.view_audit", "audit.export_audit", "audit.view_confidential_audit"]) as object,
  },
});
const plainRole = await prisma.role.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Plain", permissions: permissionMapFrom(["documents.view"]) as object },
});

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: "x", fullName: email.split("@")[0], emailVerifiedAt: new Date() } });
}
const auditorU = await makeUser("zz-audit-auditor@example.test");
await prisma.membership.create({ data: { organizationId: org.id, userId: auditorU.id, departmentId: dept.id, roleId: auditorRole.id, status: "active" } });
const auditor: PermissionActor = { userId: auditorU.id, organizationId: org.id, isSuperAdmin: false };

const adminU = await makeUser("zz-audit-admin@example.test");
await prisma.membership.create({ data: { organizationId: org.id, userId: adminU.id, departmentId: dept.id, roleId: adminRole.id, status: "active" } });
const admin: PermissionActor = { userId: adminU.id, organizationId: org.id, isSuperAdmin: false };

const plainU = await makeUser("zz-audit-plain@example.test");
await prisma.membership.create({ data: { organizationId: org.id, userId: plainU.id, departmentId: dept.id, roleId: plainRole.id, status: "active" } });
const plain: PermissionActor = { userId: plainU.id, organizationId: org.id, isSuperAdmin: false };

async function event(actorId: string, action: string, desc: string, confidential = false, occurredAt?: Date) {
  await prisma.auditEvent.create({
    data: {
      organizationId: org.id, departmentId: dept.id, actorUserId: actorId,
      action: action as never, targetDescription: desc, isConfidential: confidential,
      ...(occurredAt ? { occurredAt } : {}),
    },
  });
}

try {
  await event(auditorU.id, "view", "Viewed: ZZA-DOC-1");
  await event(adminU.id, "delete", "Moved to trash: ZZA-DOC-2");
  await event(auditorU.id, "share", "Shared ZZA-DOC-3 with someone");
  await event(adminU.id, "view", "Viewed: ZZA-VAULT-1", true); // confidential
  await event(auditorU.id, "upload", "Document created: ZZA-DOC-5", false, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));

  // ── confidential segregation (AUD-5) ──
  const adminList = await audit.listAudit(deps, admin, dept.id, {});
  check("compliance role sees all events incl. confidential", adminList.events.length === 5);
  check("and the confidential one is present", adminList.events.some((e) => e.isConfidential));
  check("compliance role can export", adminList.canExport === true);

  const auditorList = await audit.listAudit(deps, auditor, dept.id, {});
  check("plain auditor sees non-confidential events only", auditorList.events.length === 4);
  check("the confidential event is hidden", !auditorList.events.some((e) => e.isConfidential));
  check("plain auditor cannot export", auditorList.canExport === false);

  await expectError("a role without view-audit is refused", "forbidden", () =>
    audit.listAudit(deps, plain, dept.id, {}),
  );

  // ── filters combine (AUD-2) ──
  check("action filter narrows to deletes", (await audit.listAudit(deps, admin, dept.id, { action: "delete" })).events.length === 1);
  check("actor filter narrows to one person", (await audit.listAudit(deps, admin, dept.id, { actorUserId: adminU.id })).events.length === 2);
  check("document filter matches the ref in the description", (await audit.listAudit(deps, admin, dept.id, { documentQuery: "ZZA-DOC-3" })).events.length === 1);
  check("date filter excludes the 40-day-old event", (await audit.listAudit(deps, admin, dept.id, { from: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) })).events.length === 4);

  // ── export gating (AUD-4) ──
  const csv = await audit.exportAudit(deps, admin, dept.id, {});
  const lines = csv.split("\r\n");
  check("export produces a CSV with a header", lines[0].startsWith("Time,Actor,Action"));
  check("export includes every row", lines.length === 6); // header + 5
  check("export marks the confidential row", csv.includes(",yes"));
  await expectError("a view-only auditor can't export", "forbidden", () =>
    audit.exportAudit(deps, auditor, dept.id, {}),
  );
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
  await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
  await prisma.role.deleteMany({ where: { departmentId: dept.id } });
  await prisma.department.deleteMany({ where: { id: dept.id } });
  await prisma.user.deleteMany({ where: { id: { in: [auditorU.id, adminU.id, plainU.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
