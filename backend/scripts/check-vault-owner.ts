/**
 * Confidential named list: owner-only management — `npm run check:vault-owner` (backend workspace).
 *
 * SECURITY_AUDIT.md M-6. Adding and removing people on a confidential folder's named list required
 * only being *on* the list. Any member could widen the vault to anyone in the organization, or quietly
 * push every other non-owner out. Decision (2026-11-07, product owner): only the vault's **owner**
 * manages the list; other members just have access.
 *
 * Through the real HTTP stack; each refusal verified in the database and paired with an owner control.
 * DEV ONLY.
 */
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/jwt.js";
import { permissionMapFrom } from "../src/lib/permissions.js";

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
const PREFIX = "zz-vown-";

const founder = await prisma.user.create({
  data: { email: `${PREFIX}founder-${stamp}@example.test`, passwordHash: "x", fullName: "Founder", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ VaultOwner ${stamp}`, industry: "test", createdByUserId: founder.id, subfolderDepthLimit: 5 },
});
let app: ReturnType<typeof buildApp> | undefined;
try {
  const dept = await prisma.department.create({ data: { organizationId: org.id, name: "HR", idPrefix: "HRX", subfolderDepthLimit: 5 } });
  const role = await prisma.role.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "Staff", permissions: permissionMapFrom(["documents.view"]) as object },
  });
  async function person(tag: string) {
    const user = await prisma.user.create({
      data: { email: `${PREFIX}${tag}-${stamp}@example.test`, passwordHash: "x", fullName: tag, emailVerifiedAt: new Date() },
    });
    await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId: dept.id, roleId: role.id, status: "active" } });
    const auth = { authorization: `Bearer ${signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false })}` };
    return { user, auth };
  }
  const owner = await person("owner");
  const member = await person("member");
  const colleague = await person("colleague");
  const outsider = await person("outsider");

  const vault = await prisma.folder.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "Investigations", depth: 0, isConfidential: true },
  });
  await prisma.confidentialMember.createMany({
    data: [
      { folderId: vault.id, userId: owner.user.id, isOwner: true },
      { folderId: vault.id, userId: member.user.id, isOwner: false },
      { folderId: vault.id, userId: colleague.user.id, isOwner: false },
    ],
  });

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;
  const base = `/folders/${vault.id}/confidential/members`;
  const onList = async (userId: string) => (await prisma.confidentialMember.count({ where: { folderId: vault.id, userId } })) === 1;
  const body = (res: { body: string }) => JSON.parse(res.body) as { error?: string; canManage?: boolean; members?: unknown[] };

  console.log("\n── a member who isn't the owner ──");
  {
    const list = await server.inject({ method: "GET", url: base, headers: member.auth });
    check("control: a member can see the list", list.statusCode === 200 && (body(list).members?.length ?? 0) === 3, `${list.statusCode}`);
    check("…and is told they can't manage it", body(list).canManage === false, JSON.stringify(body(list).canManage));

    const add = await server.inject({ method: "POST", url: base, headers: member.auth, payload: { userId: outsider.user.id } });
    check("a member CANNOT add someone to the vault", add.statusCode === 403 && body(add).error === "not_vault_owner", `${add.statusCode} ${add.body.slice(0, 120)}`);
    check("…and the outsider is not on the list", !(await onList(outsider.user.id)));

    const remove = await server.inject({ method: "DELETE", url: `${base}/${colleague.user.id}`, headers: member.auth });
    check("a member CANNOT remove another member", remove.statusCode === 403 && body(remove).error === "not_vault_owner", `${remove.statusCode} ${remove.body.slice(0, 120)}`);
    check("…and the colleague keeps access", await onList(colleague.user.id));
  }

  console.log("\n── someone not on the list ──");
  {
    const list = await server.inject({ method: "GET", url: base, headers: outsider.auth });
    check("a non-member still can't even see the vault exists (404)", list.statusCode === 404, `${list.statusCode}`);
    const add = await server.inject({ method: "POST", url: base, headers: outsider.auth, payload: { userId: outsider.user.id } });
    check("…nor add themselves (404, not 403)", add.statusCode === 404, `${add.statusCode}`);
  }

  console.log("\n── the owner ──");
  {
    const list = await server.inject({ method: "GET", url: base, headers: owner.auth });
    check("the owner is told they can manage the list", list.statusCode === 200 && body(list).canManage === true, `${list.statusCode} ${JSON.stringify(body(list).canManage)}`);
    const add = await server.inject({ method: "POST", url: base, headers: owner.auth, payload: { userId: outsider.user.id } });
    check("control: the owner adds someone", add.statusCode === 200 && (await onList(outsider.user.id)), `${add.statusCode} ${add.body.slice(0, 120)}`);
    const remove = await server.inject({ method: "DELETE", url: `${base}/${colleague.user.id}`, headers: owner.auth });
    check("control: the owner removes a member", remove.statusCode === 200 && !(await onList(colleague.user.id)), `${remove.statusCode} ${remove.body.slice(0, 120)}`);
    const log = await prisma.auditEvent.findFirst({
      where: { organizationId: org.id, targetDescription: { contains: "Removed" } },
      orderBy: { occurredAt: "desc" },
    });
    check("…and the audit entry names who was removed", log?.targetDescription?.includes(colleague.user.email) === true, String(log?.targetDescription));
    const self = await server.inject({ method: "DELETE", url: `${base}/${owner.user.id}`, headers: owner.auth });
    check("the owner still can't be removed (anti-orphaning)", self.statusCode === 400 && body(self).error === "cannot_remove_owner", `${self.statusCode}`);
  }
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
  await prisma.confidentialMember.deleteMany({ where: { folder: { organizationId: org.id } } });
  await prisma.folder.deleteMany({ where: { organizationId: org.id } });
  await prisma.membership.deleteMany({ where: { organizationId: org.id } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
