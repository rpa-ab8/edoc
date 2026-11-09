/**
 * Session revocation — `npm run check:session-revocation` (backend workspace).
 *
 * SECURITY_AUDIT.md M-2. Access tokens live 15 minutes and carry `organizationId` / `isSuperAdmin`
 * as claims. The permission engine re-checks department memberships on every request, but several
 * paths trusted the claims instead, so a user disabled in the organization kept, until the token
 * expired:
 *   - documents shared directly with them (the share fallback checks no membership);
 *   - confidential folders they are named on (a named member needs no department role);
 *   - every org-scoped route that only needs `requireOrganization`.
 * And `refresh` never looked at `user.status`, so a disabled account kept minting tokens for the
 * refresh token's 30-day life. A stale `isSuperAdmin` claim was also trusted as-is.
 *
 * Through the real HTTP stack, with valid tokens signed *before* each change, exactly as a live
 * session would hold them. Each refusal is paired with a control that the same token works again
 * once the change is reversed.
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
import { issueToken } from "../src/lib/tokens.js";
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
const PREFIX = "zz-sesr-";

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ SessRev ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
});
let app: ReturnType<typeof buildApp> | undefined;
try {
  const deptA = await prisma.department.create({ data: { organizationId: org.id, name: "Alpha", idPrefix: "ALP", subfolderDepthLimit: 5 } });
  const deptB = await prisma.department.create({ data: { organizationId: org.id, name: "Beta", idPrefix: "BET", subfolderDepthLimit: 5 } });
  const docTypeB = await prisma.documentType.create({ data: { departmentId: deptB.id, name: "Note", idCode: "NTE" } });
  const roleA = await prisma.role.create({
    data: { organizationId: org.id, departmentId: deptA.id, name: "Staff", permissions: permissionMapFrom(["documents.view", "documents.preview"]) as object },
  });
  const roleB = await prisma.role.create({
    data: { organizationId: org.id, departmentId: deptB.id, name: "Admin", permissions: permissionMapFrom(["documents.view", "sharing.share"]) as object },
  });

  const user = await prisma.user.create({
    data: { email: `${PREFIX}u-${stamp}@example.test`, passwordHash: "x", fullName: "Member", emailVerifiedAt: new Date() },
  });
  const betaAdmin = await prisma.user.create({
    data: { email: `${PREFIX}b-${stamp}@example.test`, passwordHash: "x", fullName: "Beta Admin", emailVerifiedAt: new Date() },
  });
  // The user is a member of Alpha only; Beta's documents reach them by share or by the vault list.
  const membership = await prisma.membership.create({
    data: { organizationId: org.id, userId: user.id, departmentId: deptA.id, roleId: roleA.id, status: "active" },
  });
  await prisma.membership.create({
    data: { organizationId: org.id, userId: betaAdmin.id, departmentId: deptB.id, roleId: roleB.id, status: "active" },
  });

  const openFolder = await prisma.folder.create({ data: { organizationId: org.id, departmentId: deptB.id, name: "Open", depth: 0 } });
  const vault = await prisma.folder.create({ data: { organizationId: org.id, departmentId: deptB.id, name: "Vault", depth: 0, isConfidential: true } });
  await prisma.confidentialMember.createMany({
    data: [
      { folderId: vault.id, userId: betaAdmin.id, isOwner: true },
      { folderId: vault.id, userId: user.id, isOwner: false },
    ],
  });
  const doc = (folderId: string, n: number) =>
    prisma.document.create({
      data: { organizationId: org.id, departmentId: deptB.id, folderId, documentTypeId: docTypeB.id, documentRef: `BET-NTE-2026-8${stamp % 10000}${n}`, titleValue: `Doc ${n}` },
    });
  const sharedDoc = await doc(openFolder.id, 1);
  const vaultDoc = await doc(vault.id, 2);
  await prisma.share.create({
    data: { organizationId: org.id, documentId: sharedDoc.id, sharedByUserId: betaAdmin.id, targetType: "user", targetUserId: user.id, permission: "view", status: "active" },
  });

  // Tokens minted while everything was fine — what a live browser session holds.
  const sign = (sub: string, isSuperAdmin: boolean) =>
    ({ authorization: `Bearer ${signAccessToken(env, { sub, emailVerified: true, organizationId: org.id, isSuperAdmin })}` });
  const auth = sign(user.id, false);
  const forgedSuper = sign(user.id, true); // a stale/incorrect Super Admin claim
  const ownerAuth = sign(owner.id, true);

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;
  const get = (url: string, headers: Record<string, string>) => server.inject({ method: "GET", url, headers });
  const ok = (code: number) => code === 200;
  const denied = (code: number) => code === 401 || code === 403 || code === 404;

  console.log("\n── controls: the live session works ──");
  check("control: lists their departments", ok((await get("/departments", auth)).statusCode));
  check("control: opens the document shared with them", ok((await get(`/documents/${sharedDoc.id}`, auth)).statusCode));
  check("control: opens the vault document they are named on", ok((await get(`/documents/${vaultDoc.id}`, auth)).statusCode));
  check("control: the real Super Admin reaches the dashboard", ok((await get("/organizations/current/dashboard", ownerAuth)).statusCode));

  console.log("\n── a stale Super Admin claim ──");
  const forged = await get("/organizations/current/dashboard", forgedSuper);
  check("a token claiming Super Admin for a non-owner is NOT honoured", denied(forged.statusCode), `${forged.statusCode}`);

  console.log("\n── disabled in the organization (membership disabled), same token ──");
  await prisma.membership.update({ where: { id: membership.id }, data: { status: "disabled" } });
  {
    const r1 = await get(`/documents/${sharedDoc.id}`, auth);
    check("the shared document is no longer served", denied(r1.statusCode), `${r1.statusCode}`);
    const r2 = await get(`/documents/${vaultDoc.id}`, auth);
    check("the confidential vault document is no longer served", denied(r2.statusCode), `${r2.statusCode}`);
    const r3 = await get("/shares/with-me", auth);
    check("'Shared with me' is no longer served", denied(r3.statusCode), `${r3.statusCode}`);
    const r4 = await get("/departments", auth);
    check("org-scoped listings are no longer served", denied(r4.statusCode) || (ok(r4.statusCode) && !r4.body.includes(deptA.id)), `${r4.statusCode} ${r4.body.slice(0, 100)}`);
  }
  await prisma.membership.update({ where: { id: membership.id }, data: { status: "active" } });
  check("control: re-enabled, the same token works again", ok((await get(`/documents/${sharedDoc.id}`, auth)).statusCode));

  console.log("\n── account disabled (user.status), same token ──");
  await prisma.user.update({ where: { id: user.id }, data: { status: "disabled" } });
  {
    const r1 = await get("/auth/me", auth);
    check("the account's token is refused even for /auth/me", r1.statusCode === 401, `${r1.statusCode}`);
    const r2 = await get(`/documents/${sharedDoc.id}`, auth);
    check("…and for documents", r2.statusCode === 401, `${r2.statusCode}`);
  }

  console.log("\n── refresh for a disabled account ──");
  {
    const t1 = issueToken();
    const t2 = issueToken();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.createMany({
      data: [
        { userId: user.id, tokenHash: t1.hash, expiresAt },
        { userId: user.id, tokenHash: t2.hash, expiresAt },
      ],
    });
    const res = await server.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { dms_refresh: t1.raw },
      payload: { organizationId: org.id },
    });
    check("refresh is refused for a disabled account", res.statusCode === 401 || res.statusCode === 403, `${res.statusCode} ${res.body.slice(0, 120)}`);
    check("…and no access token is issued", !res.body.includes("accessToken"), res.body.slice(0, 120));
    const live = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    check("…and every refresh token of the account is revoked", live === 0, `${live} still live`);

    await prisma.user.update({ where: { id: user.id }, data: { status: "active" } });
    const t3 = issueToken();
    await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: t3.hash, expiresAt } });
    const again = await server.inject({ method: "POST", url: "/auth/refresh", cookies: { dms_refresh: t3.raw }, payload: { organizationId: org.id } });
    check("control: once re-enabled, a fresh session refreshes", again.statusCode === 200 && again.body.includes("accessToken"), `${again.statusCode} ${again.body.slice(0, 120)}`);
    check("control: and the old token works again", ok((await get("/auth/me", auth)).statusCode));
  }
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
  await prisma.share.deleteMany({ where: { organizationId: org.id } });
  await prisma.document.deleteMany({ where: { organizationId: org.id } });
  await prisma.confidentialMember.deleteMany({ where: { folder: { organizationId: org.id } } });
  await prisma.folder.deleteMany({ where: { organizationId: org.id } });
  await prisma.membership.deleteMany({ where: { organizationId: org.id } });
  await prisma.documentType.deleteMany({ where: { department: { organizationId: org.id } } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
