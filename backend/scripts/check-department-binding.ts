/**
 * Department binding — `npm run check:department-binding` (backend workspace).
 *
 * SECURITY_AUDIT.md H-1. A department-scoped route carries a department id AND a folder id in its
 * URL (`/departments/:departmentId/folders/:folderId/...`, or `?departmentId=&folderId=` on the
 * document listing). Access used to be resolved for the *department in the URL* while the service
 * acted on the *folder alone* — so an Admin of department Alpha could name a folder of department
 * Beta (same organization) under Alpha's URL and list, upload into, rename, move, delete or re-permission
 * it with Alpha's role.
 *
 * `check:tenant-isolation` guards the boundary between organizations; this guards the boundary
 * between departments of ONE organization, and it does so through the real HTTP stack
 * (`app.inject` with signed access tokens), because the defect lived in how the route's permission
 * gate and the service were wired together — a service-level test would not have seen it.
 *
 * Every refusal is paired with a positive control (the same call on the attacker's own folder, or by
 * a legitimate Beta member), so the check can't pass by simply breaking the feature.
 *
 * DEV ONLY. Point it at a development database. Writes a few small files to an OS temp directory.
 */
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { Redis } from "ioredis";
import dotenv from "dotenv";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/jwt.js";
import { encryptJson } from "../src/lib/crypto.js";
import { permissionMapFrom, type PermissionKey } from "../src/lib/permissions.js";

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
const PREFIX = "zz-bind-";
const storageDir = mkdtempSync(path.join(tmpdir(), "dms-bind-"));

// ─────────────────────────── fixture ───────────────────────────

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ Bind ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
});
// Everything after the org exists runs inside try, so the cleanup in `finally` always runs.
let app: ReturnType<typeof buildApp> | undefined;
try {
await prisma.storageConfig.create({
  data: {
    organizationId: org.id,
    backendType: "nas",
    status: "verified",
    credentials: { enc: encryptJson(env, { backendType: "nas", mountPath: storageDir }) },
  },
});

async function makeDept(name: string, prefix: string) {
  const dept = await prisma.department.create({
    data: { organizationId: org.id, name, idPrefix: prefix, subfolderDepthLimit: 5 },
  });
  const docType = await prisma.documentType.create({
    data: {
      departmentId: dept.id,
      name: "Note",
      idCode: "NTE",
      fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, isRequired: false, sortOrder: 0 }] },
    },
    include: { fields: true },
  });
  return { dept, docType };
}

const alpha = await makeDept("Alpha", "ALP");
const beta = await makeDept("Beta", "BET");

const ADMIN_KEYS: PermissionKey[] = [
  "documents.view", "documents.preview", "documents.download", "documents.upload", "documents.delete",
  "documents.restore", "documents.upload_version", "documents.edit_metadata", "documents.version_history",
  "folders.create", "folders.rename", "folders.move", "folders.delete",
  "members.invite", "members.remove", "members.change_role", "configuration.edit_rules", "search.search",
];
const alphaAdminRole = await prisma.role.create({
  data: { organizationId: org.id, departmentId: alpha.dept.id, name: "Alpha Admin", permissions: permissionMapFrom(ADMIN_KEYS) as object },
});
const betaAdminRole = await prisma.role.create({
  data: { organizationId: org.id, departmentId: beta.dept.id, name: "Beta Admin", permissions: permissionMapFrom(ADMIN_KEYS) as object },
});
const betaStaffRole = await prisma.role.create({
  data: { organizationId: org.id, departmentId: beta.dept.id, name: "Beta Staff", permissions: permissionMapFrom(["documents.view", "documents.preview"]) as object },
});

async function makeUser(tag: string, departmentId: string, roleId: string) {
  const user = await prisma.user.create({
    data: { email: `${PREFIX}${tag}-${stamp}@example.test`, passwordHash: "x", fullName: tag, emailVerifiedAt: new Date() },
  });
  await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId, roleId, status: "active" } });
  const token = signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

// The attacker: a full administrator — but of Alpha only.
const attacker = await makeUser("alpha-admin", alpha.dept.id, alphaAdminRole.id);
const betaAdmin = await makeUser("beta-admin", beta.dept.id, betaAdminRole.id);

async function folder(departmentId: string, name: string, parentFolderId: string | null = null, depth = 0) {
  return prisma.folder.create({ data: { organizationId: org.id, departmentId, name, parentFolderId, depth } });
}
const alphaFolder = await folder(alpha.dept.id, "Alpha General");
const alphaChild = await folder(alpha.dept.id, "Alpha Child", alphaFolder.id, 1);
const alphaEmpty = await folder(alpha.dept.id, "Alpha Empty");
const betaFolder = await folder(beta.dept.id, "Beta Payroll");
const betaChild = await folder(beta.dept.id, "Beta Child", betaFolder.id, 1);
const betaEmpty = await folder(beta.dept.id, "Beta Empty");

app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
await app.ready();
const server = app;

/** A hand-built multipart body — one file part plus text fields — for `app.inject`. */
function multipart(fields: Record<string, string>, fileName: string, content: Buffer) {
  const boundary = `----dmsbind${stamp}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(auth: Record<string, string>, departmentId: string, folderId: string, docTypeId: string, title: string, fieldDefId: string) {
  const body = multipart(
    { documentTypeId: docTypeId, fieldValues: JSON.stringify([{ fieldDefId, value: title }]), onDuplicate: "keep_both" },
    `${title}.pdf`,
    Buffer.from(`%PDF-1.4\n% ${title} ${stamp}\n%%EOF\n`),
  );
  return server.inject({
    method: "POST",
    url: `/departments/${departmentId}/folders/${folderId}/documents/upload`,
    headers: { ...auth, ...body.headers },
    payload: body.payload,
  });
}

const refused = (code: number) => code === 403 || code === 404;

  // Beta's own admin files a document into Beta — the thing the attacker will try to reach.
  const betaUp = await upload(betaAdmin.auth, beta.dept.id, betaFolder.id, beta.docType.id, "Beta Salary Sheet", beta.docType.fields[0].id);
  check("setup: Beta admin can upload into Beta", betaUp.statusCode === 201, `${betaUp.statusCode} ${betaUp.body}`);
  const betaRef = (betaUp.json() as { document?: { documentRef: string } }).document?.documentRef ?? "BET-NTE";

  console.log("\n── listing another department's folder under your own department ──");
  {
    const own = await server.inject({ method: "GET", url: `/documents?departmentId=${alpha.dept.id}&folderId=${alphaFolder.id}`, headers: attacker.auth });
    check("control: attacker lists their own Alpha folder", own.statusCode === 200, `${own.statusCode}`);
    const legit = await server.inject({ method: "GET", url: `/documents?departmentId=${beta.dept.id}&folderId=${betaFolder.id}`, headers: betaAdmin.auth });
    check("control: Beta admin lists the Beta folder and sees the document", legit.statusCode === 200 && legit.body.includes(betaRef), `${legit.statusCode}`);

    const res = await server.inject({ method: "GET", url: `/documents?departmentId=${alpha.dept.id}&folderId=${betaFolder.id}`, headers: attacker.auth });
    check("Alpha admin CANNOT list a Beta folder via Alpha's department id", refused(res.statusCode), `${res.statusCode}`);
    check("…and the Beta document's ID never appears in the response", !res.body.includes(betaRef), res.body.slice(0, 160));
  }

  console.log("\n── breadcrumb / my-permissions ──");
  {
    const own = await server.inject({ method: "GET", url: `/departments/${alpha.dept.id}/folders/${alphaChild.id}/path`, headers: attacker.auth });
    check("control: attacker reads their own folder path", own.statusCode === 200, `${own.statusCode}`);
    const res = await server.inject({ method: "GET", url: `/departments/${alpha.dept.id}/folders/${betaChild.id}/path`, headers: attacker.auth });
    check("Alpha admin CANNOT read a Beta folder path via Alpha's URL", refused(res.statusCode), `${res.statusCode}`);
    check("…and the Beta folder name is not returned", !res.body.includes("Beta Payroll"), res.body.slice(0, 160));

    const perms = await server.inject({ method: "GET", url: `/departments/${alpha.dept.id}/my-permissions?folderId=${betaFolder.id}`, headers: attacker.auth });
    const p = (perms.json() as { permissions?: Record<string, boolean> }).permissions ?? {};
    check("my-permissions grants nothing for a folder of another department", Object.values(p).every((v) => v !== true), JSON.stringify(p).slice(0, 160));
  }

  console.log("\n── upload into another department's folder ──");
  {
    const own = await upload(attacker.auth, alpha.dept.id, alphaFolder.id, alpha.docType.id, "Alpha Note", alpha.docType.fields[0].id);
    check("control: attacker uploads into their own Alpha folder", own.statusCode === 201, `${own.statusCode} ${own.body.slice(0, 120)}`);

    const before = await prisma.document.count({ where: { folderId: betaFolder.id } });
    const res = await upload(attacker.auth, alpha.dept.id, betaFolder.id, beta.docType.id, "Planted", beta.docType.fields[0].id);
    const after = await prisma.document.count({ where: { folderId: betaFolder.id } });
    check("Alpha admin CANNOT upload into a Beta folder via Alpha's URL", refused(res.statusCode), `${res.statusCode} ${res.body.slice(0, 120)}`);
    check("…and no document was created in the Beta folder", after === before, `${before} → ${after}`);
  }

  console.log("\n── rename / move / delete another department's folder ──");
  {
    const own = await server.inject({ method: "PATCH", url: `/departments/${alpha.dept.id}/folders/${alphaEmpty.id}`, headers: attacker.auth, payload: { name: "Alpha Renamed" } });
    check("control: attacker renames their own folder", own.statusCode === 200, `${own.statusCode}`);

    const res = await server.inject({ method: "PATCH", url: `/departments/${alpha.dept.id}/folders/${betaFolder.id}`, headers: attacker.auth, payload: { name: "Pwned" } });
    const name = (await prisma.folder.findUniqueOrThrow({ where: { id: betaFolder.id } })).name;
    check("Alpha admin CANNOT rename a Beta folder", refused(res.statusCode), `${res.statusCode}`);
    check("…and its name is unchanged", name === "Beta Payroll", name);

    const ownMove = await server.inject({ method: "POST", url: `/departments/${alpha.dept.id}/folders/${alphaChild.id}/move`, headers: attacker.auth, payload: { parentFolderId: null } });
    check("control: attacker moves their own subfolder to the root", ownMove.statusCode === 200, `${ownMove.statusCode} ${ownMove.body.slice(0, 120)}`);

    const mv = await server.inject({ method: "POST", url: `/departments/${alpha.dept.id}/folders/${betaChild.id}/move`, headers: attacker.auth, payload: { parentFolderId: null } });
    const parent = (await prisma.folder.findUniqueOrThrow({ where: { id: betaChild.id } })).parentFolderId;
    check("Alpha admin CANNOT move a Beta folder", refused(mv.statusCode), `${mv.statusCode}`);
    check("…and it is still under its Beta parent", parent === betaFolder.id, String(parent));

    const del = await server.inject({ method: "DELETE", url: `/departments/${alpha.dept.id}/folders/${betaEmpty.id}`, headers: attacker.auth });
    const still = await prisma.folder.findUnique({ where: { id: betaEmpty.id } });
    check("Alpha admin CANNOT delete an (empty) Beta folder", refused(del.statusCode), `${del.statusCode}`);
    check("…and it still exists", still !== null);
  }

  console.log("\n── folder permission overrides on another department's folder ──");
  {
    const own = await server.inject({ method: "GET", url: `/departments/${alpha.dept.id}/folders/${alphaFolder.id}/permissions`, headers: attacker.auth });
    check("control: attacker reads overrides on their own folder", own.statusCode === 200, `${own.statusCode}`);

    const list = await server.inject({ method: "GET", url: `/departments/${alpha.dept.id}/folders/${betaFolder.id}/permissions`, headers: attacker.auth });
    check("Alpha admin CANNOT read Beta's folder overrides", refused(list.statusCode), `${list.statusCode}`);
    check("…and Beta's role ids are not disclosed", !list.body.includes(betaStaffRole.id), list.body.slice(0, 160));

    const put = await server.inject({
      method: "PUT",
      url: `/departments/${alpha.dept.id}/folders/${betaFolder.id}/permissions/${betaStaffRole.id}`,
      headers: attacker.auth,
      payload: { restrict: ["documents.view"] },
    });
    const overrides = await prisma.folderPermission.count({ where: { folderId: betaFolder.id } });
    check("Alpha admin CANNOT restrict Beta staff on a Beta folder", refused(put.statusCode), `${put.statusCode}`);
    check("…and no override row was written", overrides === 0, `${overrides}`);

    const legit = await server.inject({
      method: "PUT",
      url: `/departments/${beta.dept.id}/folders/${betaFolder.id}/permissions/${betaStaffRole.id}`,
      headers: betaAdmin.auth,
      payload: { restrict: ["documents.preview"] },
    });
    check("control: Beta admin CAN set an override on their own folder", legit.statusCode === 200, `${legit.statusCode} ${legit.body.slice(0, 120)}`);

    const clr = await server.inject({
      method: "DELETE",
      url: `/departments/${alpha.dept.id}/folders/${betaFolder.id}/permissions/${betaStaffRole.id}`,
      headers: attacker.auth,
    });
    const survived = await prisma.folderPermission.count({ where: { folderId: betaFolder.id, roleId: betaStaffRole.id } });
    check("Alpha admin CANNOT clear Beta's override", refused(clr.statusCode), `${clr.statusCode}`);
    check("…and Beta's override is still in place", survived === 1, `${survived}`);
  }

  console.log("\n── legal hold on another department's folder (already bound — kept as a guard) ──");
  {
    const res = await server.inject({
      method: "POST",
      url: `/departments/${alpha.dept.id}/folders/${betaFolder.id}/legal-hold`,
      headers: attacker.auth,
      payload: { reason: "x" },
    });
    check("Alpha admin CANNOT place a hold on a Beta folder", refused(res.statusCode), `${res.statusCode}`);
  }
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
  await prisma.legalHold.deleteMany({ where: { organizationId: org.id } });
  await prisma.folderPermission.deleteMany({ where: { folder: { organizationId: org.id } } });
  await prisma.share.deleteMany({ where: { organizationId: org.id } });
  await prisma.fieldValue.deleteMany({ where: { document: { organizationId: org.id } } });
  await prisma.document.updateMany({ where: { organizationId: org.id }, data: { currentVersionId: null } });
  await prisma.version.deleteMany({ where: { organizationId: org.id } });
  await prisma.document.deleteMany({ where: { organizationId: org.id } });
  await prisma.documentRefSequence.deleteMany({ where: { organizationId: org.id } });
  await prisma.folder.updateMany({ where: { organizationId: org.id }, data: { parentFolderId: null } });
  await prisma.folder.deleteMany({ where: { organizationId: org.id } });
  await prisma.membership.deleteMany({ where: { organizationId: org.id } });
  await prisma.fieldDef.deleteMany({ where: { documentType: { department: { organizationId: org.id } } } });
  await prisma.documentType.deleteMany({ where: { department: { organizationId: org.id } } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.storageConfig.deleteMany({ where: { organizationId: org.id } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  rmSync(storageDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
