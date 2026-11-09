/**
 * External-link re-validation — `npm run check:link-revalidation` (backend workspace).
 *
 * SECURITY_AUDIT.md H-4. An external link was checked only for token, status and expiry when it was
 * opened. Everything that made it legal to create — the document being live, its folder not being
 * confidential, the sharer still holding external-link rights here, the department still allowing
 * links — was checked once, at creation, and never again. So a link kept serving the file after:
 *   - the document was moved to the trash;
 *   - its folder (or an ancestor) became confidential ("a confidential document can never leave by
 *     link", Feature Spec §11.2);
 *   - the sharer was removed / disabled, or their role lost the link permissions;
 *   - the department turned external links off.
 * And a download link kept downloading after the sharer lost download access.
 *
 * Each case: a fresh link is proven to work, the condition is changed, the link is proven dead on
 * both the open and the file endpoint (and nothing is logged / counted), then the condition is put
 * back and the link works again. Through the real HTTP stack (`app.inject`).
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
const PREFIX = "zz-lrv-";
const storageDir = mkdtempSync(path.join(tmpdir(), "dms-lrv-"));

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ LinkReval ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
});
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
  const LINKS_ON = { defaultSharing: { externalLinksEnabled: true, linkExpiryDays: 7 } };
  const dept = await prisma.department.create({
    data: { organizationId: org.id, name: "Legal", idPrefix: "LEG", subfolderDepthLimit: 5, rules: LINKS_ON },
  });
  const docType = await prisma.documentType.create({
    data: {
      departmentId: dept.id,
      name: "Contract",
      idCode: "CTR",
      fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, isRequired: false, sortOrder: 0 }] },
    },
    include: { fields: true },
  });

  const SHARER_KEYS: PermissionKey[] = [
    "documents.view", "documents.preview", "documents.download", "documents.upload",
    "sharing.share", "sharing.create_link", "sharing.external_share",
  ];
  const sharerRole = await prisma.role.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "Sharer", permissions: permissionMapFrom(SHARER_KEYS) as object },
  });
  const sharerUser = await prisma.user.create({
    data: { email: `${PREFIX}sharer-${stamp}@example.test`, passwordHash: "x", fullName: "Sharer", emailVerifiedAt: new Date() },
  });
  const membership = await prisma.membership.create({
    data: { organizationId: org.id, userId: sharerUser.id, departmentId: dept.id, roleId: sharerRole.id, status: "active" },
  });
  const sharerAuth = {
    authorization: `Bearer ${signAccessToken(env, { sub: sharerUser.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false })}`,
  };

  const parent = await prisma.folder.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "Matters", parentFolderId: null, depth: 0 },
  });
  const child = await prisma.folder.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "Acme", parentFolderId: parent.id, depth: 1 },
  });

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;

  const boundary = `----dmslrv${stamp}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="documentTypeId"\r\n\r\n${docType.id}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fieldValues"\r\n\r\n${JSON.stringify([{ fieldDefId: docType.fields[0].id, value: "Acme NDA" }])}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="onDuplicate"\r\n\r\nkeep_both\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nda.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(`%PDF-1.4\n% nda ${stamp}\n%%EOF\n`),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await server.inject({
    method: "POST",
    url: `/departments/${dept.id}/folders/${child.id}/documents/upload`,
    headers: { ...sharerAuth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  check("setup: sharer uploads a document", up.statusCode === 201, `${up.statusCode} ${up.body.slice(0, 160)}`);
  const documentId = (up.json() as { document: { id: string } }).document.id;

  async function newLink(permission: "view" | "download") {
    const res = await server.inject({
      method: "POST",
      url: `/documents/${documentId}/shares`,
      headers: sharerAuth,
      payload: { targetType: "external_link", permission, expiresInDays: 7 },
    });
    if (res.statusCode !== 201) throw new Error(`link create failed: ${res.statusCode} ${res.body}`);
    const { linkUrl, share } = res.json() as { linkUrl: string; share: { id: string } };
    return { token: linkUrl.split("/l/")[1], shareId: share.id };
  }
  const open = (token: string) => server.inject({ method: "GET", url: `/links/${token}` });
  const fileOf = (token: string, download = false) =>
    server.inject({ method: "GET", url: `/links/${token}/file${download ? "?download=1" : ""}` });

  /** Link works → condition applied → dead on both endpoints, nothing logged → restored → works. */
  async function scenario(name: string, apply: () => Promise<unknown>, restore: () => Promise<unknown>) {
    console.log(`\n── ${name} ──`);
    const { token, shareId } = await newLink("view");
    const okOpen = await open(token);
    const okFile = await fileOf(token);
    check("control: the link opens before the change", okOpen.statusCode === 200 && okFile.statusCode === 200, `${okOpen.statusCode}/${okFile.statusCode}`);

    await apply();
    const countBefore = (await prisma.share.findUniqueOrThrow({ where: { id: shareId } })).openedCount;
    const logsBefore = await prisma.auditEvent.count({ where: { organizationId: org.id, action: "link_access" } });
    const deadOpen = await open(token);
    const deadFile = await fileOf(token);
    const countAfter = (await prisma.share.findUniqueOrThrow({ where: { id: shareId } })).openedCount;
    const logsAfter = await prisma.auditEvent.count({ where: { organizationId: org.id, action: "link_access" } });
    check("the link no longer opens", deadOpen.statusCode === 404, `${deadOpen.statusCode} ${deadOpen.body.slice(0, 100)}`);
    check("…and no longer serves the file", deadFile.statusCode === 404, `${deadFile.statusCode}`);
    check("…with the same uniform 'no longer available' answer", deadOpen.body.includes("link_unavailable") && deadFile.body.includes("link_unavailable"), deadOpen.body.slice(0, 100));
    check("…and the refused open is neither counted nor logged as an access", countAfter === countBefore && logsAfter === logsBefore, `${countBefore}→${countAfter}, ${logsBefore}→${logsAfter}`);

    await restore();
    const back = await open(token);
    check("control: the link works again once the condition is reversed", back.statusCode === 200, `${back.statusCode}`);
  }

  await scenario(
    "document moved to the trash",
    () => prisma.document.update({ where: { id: documentId }, data: { status: "in_trash", deletedAt: new Date() } }),
    () => prisma.document.update({ where: { id: documentId }, data: { status: "active", deletedAt: null } }),
  );
  await scenario(
    "an ancestor folder becomes confidential",
    () => prisma.folder.update({ where: { id: parent.id }, data: { isConfidential: true } }),
    () => prisma.folder.update({ where: { id: parent.id }, data: { isConfidential: false } }),
  );
  await scenario(
    "the document's own folder becomes confidential",
    () => prisma.folder.update({ where: { id: child.id }, data: { isConfidential: true } }),
    () => prisma.folder.update({ where: { id: child.id }, data: { isConfidential: false } }),
  );
  await scenario(
    "the sharer is disabled in the department",
    () => prisma.membership.update({ where: { id: membership.id }, data: { status: "disabled" } }),
    () => prisma.membership.update({ where: { id: membership.id }, data: { status: "active" } }),
  );
  await scenario(
    "the sharer's account is disabled",
    () => prisma.user.update({ where: { id: sharerUser.id }, data: { status: "disabled" } }),
    () => prisma.user.update({ where: { id: sharerUser.id }, data: { status: "active" } }),
  );
  await scenario(
    "the sharer's role loses external sharing",
    () => prisma.role.update({ where: { id: sharerRole.id }, data: { permissions: permissionMapFrom(SHARER_KEYS.filter((k) => k !== "sharing.external_share")) as object } }),
    () => prisma.role.update({ where: { id: sharerRole.id }, data: { permissions: permissionMapFrom(SHARER_KEYS) as object } }),
  );
  await scenario(
    "the department turns external links off",
    () => prisma.department.update({ where: { id: dept.id }, data: { rules: { defaultSharing: { externalLinksEnabled: false, linkExpiryDays: 7 } } } }),
    () => prisma.department.update({ where: { id: dept.id }, data: { rules: LINKS_ON } }),
  );

  console.log("\n── a download link after the sharer loses download ──");
  {
    const { token } = await newLink("download");
    const okDl = await fileOf(token, true);
    check("control: the download link downloads", okDl.statusCode === 200, `${okDl.statusCode}`);

    await prisma.role.update({
      where: { id: sharerRole.id },
      data: { permissions: permissionMapFrom(SHARER_KEYS.filter((k) => k !== "documents.download")) as object },
    });
    const dl = await fileOf(token, true);
    const view = await fileOf(token);
    const meta = await open(token);
    check("it no longer downloads", dl.statusCode === 403, `${dl.statusCode}`);
    check("…but still previews (the sharer can still preview)", view.statusCode === 200, `${view.statusCode}`);
    check("…and reports itself as view-only", meta.statusCode === 200 && (meta.json() as { document: { permission: string } }).document.permission === "view", meta.body.slice(0, 120));
    await prisma.role.update({ where: { id: sharerRole.id }, data: { permissions: permissionMapFrom(SHARER_KEYS) as object } });
  }

  console.log("\n── an explicit revoke is still final ──");
  {
    const { token, shareId } = await newLink("view");
    await server.inject({ method: "DELETE", url: `/shares/${shareId}`, headers: sharerAuth });
    const res = await open(token);
    check("a revoked link stays dead", res.statusCode === 404, `${res.statusCode}`);
  }
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
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
