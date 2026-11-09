/**
 * Role escalation — `npm run check:role-escalation` (backend workspace).
 *
 * SECURITY_AUDIT.md H-3. Assigning a role was already bounded by `canGrantRole` ("nobody hands out a
 * role with more access than they hold"), but *editing* roles was not: `createRole`, `copyRole`,
 * `updateRole` and `deleteRole` required only `members.change_role`. A delegated "HR Manager" could
 * tick every box on their own role and become a Department Admin, write a super-role and copy the
 * Admin role, or strip / rename / delete roles above them.
 *
 * Checked through the real HTTP stack (`app.inject`). Each refusal is checked against the database
 * (nothing was written), and paired with a positive control: the same manager editing within their
 * own reach still works, a no-op re-save of a role above them (which the roles page sends for every
 * role) still succeeds, and the Department Admin can do everything.
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
const PREFIX = "zz-resc-";

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ RoleEsc ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
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
  // Staff (below) is a strict subset of HR; Auditor and the Admin role are not.
  const HR_KEYS: PermissionKey[] = ["documents.view", "documents.preview", "members.invite", "members.change_role"];
  const adminRole = await role("Department Admin", ALL_PERMISSION_KEYS, true);
  const hrRole = await role("HR Manager", HR_KEYS);
  const staffRole = await role("Staff", ["documents.view", "documents.preview"]);
  // Unused, and holds something HR doesn't — a role "above" the HR manager.
  const auditorRole = await role("Auditor", ["audit.view_audit", "audit.export_audit"]);

  async function makeUser(tag: string, roleId: string) {
    const user = await prisma.user.create({
      data: { email: `${PREFIX}${tag}-${stamp}@example.test`, passwordHash: "x", fullName: tag, emailVerifiedAt: new Date() },
    });
    await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId: dept.id, roleId, status: "active" } });
    const token = signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false });
    return { user, auth: { authorization: `Bearer ${token}` } };
  }
  const admin = await makeUser("admin", adminRole.id);
  const hr = await makeUser("hr", hrRole.id);
  await makeUser("staff", staffRole.id);

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;

  const base = `/departments/${dept.id}/roles`;
  const refused = (code: number) => code === 403;
  const stored = async (id: string) => {
    const r = await prisma.role.findUnique({ where: { id } });
    return r ? { name: r.name, permissions: r.permissions as Record<string, boolean> } : null;
  };
  const full = permissionMapFrom(ALL_PERMISSION_KEYS);

  console.log("\n── creating a role ──");
  {
    const res = await server.inject({ method: "POST", url: base, headers: hr.auth, payload: { name: "Super", permissions: full } });
    const made = await prisma.role.count({ where: { departmentId: dept.id, name: "Super" } });
    check("HR manager CANNOT create a role with every permission", refused(res.statusCode), `${res.statusCode} ${res.body.slice(0, 120)}`);
    check("…and no such role exists", made === 0, `${made}`);

    const sneaky = await server.inject({
      method: "POST",
      url: base,
      headers: hr.auth,
      payload: { name: "Exporter", permissions: permissionMapFrom(["documents.view", "audit.export_audit"]) },
    });
    check("HR manager CANNOT create a role with even one permission they lack", refused(sneaky.statusCode), `${sneaky.statusCode}`);

    const ok = await server.inject({
      method: "POST",
      url: base,
      headers: hr.auth,
      payload: { name: "Junior", permissions: permissionMapFrom(["documents.view", "members.invite"]) },
    });
    check("control: HR manager creates a role within their own reach", ok.statusCode === 201, `${ok.statusCode} ${ok.body.slice(0, 120)}`);
  }

  console.log("\n── editing your own role upward ──");
  {
    const before = await stored(hrRole.id);
    const res = await server.inject({
      method: "PUT",
      url: `${base}/${hrRole.id}`,
      headers: hr.auth,
      payload: { name: "HR Manager", permissions: full },
    });
    const after = await stored(hrRole.id);
    check("HR manager CANNOT grant their own role every permission", refused(res.statusCode), `${res.statusCode} ${res.body.slice(0, 120)}`);
    check("…and their role is unchanged", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after?.permissions).slice(0, 120));
    check("…so they still can't edit configuration", after?.permissions["configuration.edit_rules"] !== true);
  }

  console.log("\n── editing a lower role ──");
  {
    const up = await server.inject({
      method: "PUT",
      url: `${base}/${staffRole.id}`,
      headers: hr.auth,
      payload: { name: "Staff", permissions: permissionMapFrom(["documents.view", "documents.preview", "sharing.external_share"]) },
    });
    const after = await stored(staffRole.id);
    check("HR manager CANNOT give a lower role a permission they lack", refused(up.statusCode), `${up.statusCode}`);
    check("…and that role is unchanged", after?.permissions["sharing.external_share"] !== true);

    const ok = await server.inject({
      method: "PUT",
      url: `${base}/${staffRole.id}`,
      headers: hr.auth,
      payload: { name: "Staff", permissions: permissionMapFrom(["documents.view", "members.invite"]) },
    });
    check("control: HR manager edits a lower role within their reach", ok.statusCode === 200, `${ok.statusCode} ${ok.body.slice(0, 120)}`);
  }

  console.log("\n── changing a role above you ──");
  {
    const before = await stored(adminRole.id);
    const strip = await server.inject({
      method: "PUT",
      url: `${base}/${adminRole.id}`,
      headers: hr.auth,
      payload: { name: "Department Admin", permissions: permissionMapFrom(["documents.view", "members.change_role", "configuration.edit_rules"]) },
    });
    check("HR manager CANNOT strip the Department Admin role", refused(strip.statusCode), `${strip.statusCode}`);
    const rename = await server.inject({
      method: "PUT",
      url: `${base}/${adminRole.id}`,
      headers: hr.auth,
      payload: { name: "Former Admin", permissions: before!.permissions },
    });
    check("HR manager CANNOT rename the Department Admin role", refused(rename.statusCode), `${rename.statusCode}`);
    check("…and the Admin role is unchanged", JSON.stringify(await stored(adminRole.id)) === JSON.stringify(before));

    // The roles page re-PUTs every role on save — an unchanged role above you must not block it.
    const noop = await server.inject({
      method: "PUT",
      url: `${base}/${adminRole.id}`,
      headers: hr.auth,
      payload: { name: "Department Admin", permissions: before!.permissions },
    });
    check("control: an unchanged re-save of the Admin role still succeeds", noop.statusCode === 200, `${noop.statusCode} ${noop.body.slice(0, 120)}`);

    const del = await server.inject({ method: "DELETE", url: `${base}/${auditorRole.id}`, headers: hr.auth });
    check("HR manager CANNOT delete an (unused) role above them", refused(del.statusCode), `${del.statusCode}`);
    check("…and it still exists", (await stored(auditorRole.id)) !== null);

    const junior = await prisma.role.findFirst({ where: { departmentId: dept.id, name: "Junior" } });
    const delOk = await server.inject({ method: "DELETE", url: `${base}/${junior?.id}`, headers: hr.auth });
    check("control: HR manager deletes a role within their reach", delOk.statusCode === 200, `${delOk.statusCode} ${delOk.body.slice(0, 120)}`);
  }

  console.log("\n── copying a role ──");
  {
    const res = await server.inject({ method: "POST", url: `${base}/${adminRole.id}/copy`, headers: hr.auth, payload: { name: "Admin Copy" } });
    const made = await prisma.role.count({ where: { departmentId: dept.id, name: "Admin Copy" } });
    check("HR manager CANNOT copy the Department Admin role", refused(res.statusCode), `${res.statusCode}`);
    check("…and no copy exists", made === 0, `${made}`);

    const ok = await server.inject({ method: "POST", url: `${base}/${staffRole.id}/copy`, headers: hr.auth, payload: { name: "Staff Copy" } });
    check("control: HR manager copies a role within their reach", ok.statusCode === 201, `${ok.statusCode} ${ok.body.slice(0, 120)}`);
  }

  console.log("\n── controls: the Department Admin is unaffected ──");
  {
    const create = await server.inject({ method: "POST", url: base, headers: admin.auth, payload: { name: "Admin Two", permissions: full } });
    check("Department Admin creates a full-permission role", create.statusCode === 201, `${create.statusCode} ${create.body.slice(0, 120)}`);
    const edit = await server.inject({
      method: "PUT",
      url: `${base}/${staffRole.id}`,
      headers: admin.auth,
      payload: { name: "Staff", permissions: permissionMapFrom(["documents.view", "audit.export_audit"]) },
    });
    check("Department Admin raises a lower role", edit.statusCode === 200, `${edit.statusCode} ${edit.body.slice(0, 120)}`);
    const copy = await server.inject({ method: "POST", url: `${base}/${adminRole.id}/copy`, headers: admin.auth, payload: { name: "Admin Three" } });
    check("Department Admin copies the Admin role", copy.statusCode === 201, `${copy.statusCode}`);
    const del = await server.inject({ method: "DELETE", url: `${base}/${auditorRole.id}`, headers: admin.auth });
    check("Department Admin deletes the Auditor role", del.statusCode === 200, `${del.statusCode} ${del.body.slice(0, 120)}`);
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
