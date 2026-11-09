/**
 * Member hierarchy — `npm run check:member-hierarchy` (backend workspace).
 *
 * SECURITY_AUDIT.md M-7, the member-side half of H-3. `changeMemberRole` / `removeMember` checked the
 * *new* role (canGrantRole) and the last-admin guard, but never the person being acted on. A role
 * holding `members.change_role` / `members.remove` could demote or remove a Department Admin, one at
 * a time, as long as another admin remained.
 *
 * Rule: the target's *current* role must be within the actor's own access. Checked through the real
 * HTTP stack (`app.inject`), each refusal verified in the database and paired with a positive control.
 *
 * DEV ONLY. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/jwt.js";
import { ALL_PERMISSION_KEYS, permissionMapFrom, type PermissionKey } from "../src/lib/permissions.js";

const prisma = new PrismaClient();
const env = loadEnv();
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

const stamp = Date.now();
const PREFIX = "zz-mhier-";

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ MemberHier ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
});
let app: ReturnType<typeof buildApp> | undefined;
try {
  const dept = await prisma.department.create({
    data: { organizationId: org.id, name: "Ops", idPrefix: "OPS", subfolderDepthLimit: 5 },
  });

  async function role(name: string, keys: PermissionKey[], isSystem = false) {
    return prisma.role.create({
      data: { organizationId: org.id, departmentId: dept.id, name, isSystem, permissions: permissionMapFrom(keys) as object },
    });
  }
  const adminRole = await role("Department Admin", ALL_PERMISSION_KEYS, true);
  const hrRole = await role("HR Manager", ["documents.view", "documents.preview", "members.invite", "members.change_role", "members.remove"]);
  const staffRole = await role("Staff", ["documents.view", "documents.preview"]);
  // Not above HR overall, but holds one key HR lacks — still out of HR's reach.
  const auditorRole = await role("Auditor", ["documents.view", "audit.view_audit"]);

  async function makeUser(tag: string, roleId: string) {
    const user = await prisma.user.create({
      data: { email: `${PREFIX}${tag}-${stamp}@example.test`, passwordHash: "x", fullName: tag, emailVerifiedAt: new Date() },
    });
    await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId: dept.id, roleId, status: "active" } });
    const token = signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false });
    return { user, auth: { authorization: `Bearer ${token}` } };
  }
  const admin1 = await makeUser("admin1", adminRole.id);
  const admin2 = await makeUser("admin2", adminRole.id);
  const admin3 = await makeUser("admin3", adminRole.id);
  const hr = await makeUser("hr", hrRole.id);
  const auditor = await makeUser("auditor", auditorRole.id);
  const staff1 = await makeUser("staff1", staffRole.id);
  const staff2 = await makeUser("staff2", staffRole.id);

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;

  const url = (userId: string) => `/departments/${dept.id}/members/${userId}`;
  const roleOf = async (userId: string) =>
    (await prisma.membership.findUnique({ where: { userId_departmentId: { userId, departmentId: dept.id } } }))?.roleId ?? null;

  console.log("\n── acting on someone above you ──");
  {
    const demote = await server.inject({ method: "PATCH", url: url(admin2.user.id), headers: hr.auth, payload: { roleId: staffRole.id } });
    check("HR manager CANNOT demote a Department Admin (other admins remain)", demote.statusCode === 403, `${demote.statusCode} ${demote.body.slice(0, 120)}`);
    check("…and the admin keeps their role", (await roleOf(admin2.user.id)) === adminRole.id);

    const remove = await server.inject({ method: "DELETE", url: url(admin3.user.id), headers: hr.auth });
    check("HR manager CANNOT remove a Department Admin (other admins remain)", remove.statusCode === 403, `${remove.statusCode} ${remove.body.slice(0, 120)}`);
    check("…and the admin is still a member", (await roleOf(admin3.user.id)) === adminRole.id);

    const sideways = await server.inject({ method: "PATCH", url: url(auditor.user.id), headers: hr.auth, payload: { roleId: staffRole.id } });
    check("HR manager CANNOT change a member whose role holds a key they lack", sideways.statusCode === 403, `${sideways.statusCode}`);
    check("…and that member keeps their role", (await roleOf(auditor.user.id)) === auditorRole.id);

    const removeSideways = await server.inject({ method: "DELETE", url: url(auditor.user.id), headers: hr.auth });
    check("HR manager CANNOT remove that member either", removeSideways.statusCode === 403, `${removeSideways.statusCode}`);
  }

  console.log("\n── controls: within your reach ──");
  {
    const promote = await server.inject({ method: "PATCH", url: url(staff1.user.id), headers: hr.auth, payload: { roleId: hrRole.id } });
    check("control: HR manager changes a Staff member's role (to one they can grant)", promote.statusCode === 200, `${promote.statusCode} ${promote.body.slice(0, 120)}`);
    check("…and it took effect", (await roleOf(staff1.user.id)) === hrRole.id);

    const remove = await server.inject({ method: "DELETE", url: url(staff2.user.id), headers: hr.auth });
    check("control: HR manager removes a Staff member", remove.statusCode === 200, `${remove.statusCode} ${remove.body.slice(0, 120)}`);
    check("…and they are gone", (await roleOf(staff2.user.id)) === null);

    const peer = await server.inject({ method: "PATCH", url: url(staff1.user.id), headers: hr.auth, payload: { roleId: staffRole.id } });
    check("control: HR manager changes a peer with the same role", peer.statusCode === 200, `${peer.statusCode}`);

    const self = await server.inject({ method: "PATCH", url: url(hr.user.id), headers: hr.auth, payload: { roleId: staffRole.id } });
    check("control: HR manager can step their own role down", self.statusCode === 200, `${self.statusCode} ${self.body.slice(0, 120)}`);
  }

  console.log("\n── controls: the Department Admin is unaffected ──");
  {
    const demote = await server.inject({ method: "PATCH", url: url(admin2.user.id), headers: admin1.auth, payload: { roleId: staffRole.id } });
    check("Department Admin demotes another admin", demote.statusCode === 200, `${demote.statusCode} ${demote.body.slice(0, 120)}`);
    const remove = await server.inject({ method: "DELETE", url: url(admin3.user.id), headers: admin1.auth });
    check("Department Admin removes another admin", remove.statusCode === 200, `${remove.statusCode}`);
    const last = await server.inject({ method: "DELETE", url: url(admin1.user.id), headers: admin1.auth });
    check("the last-admin guard still holds", last.statusCode === 400, `${last.statusCode} ${last.body.slice(0, 120)}`);
  }
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
  await prisma.membership.deleteMany({ where: { organizationId: org.id } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
