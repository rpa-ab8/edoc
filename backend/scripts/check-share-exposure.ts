/**
 * Share & history exposure — `npm run check:share-exposure` (backend workspace).
 *
 * SECURITY_AUDIT.md H-2. A view-only share is documented to give "the document ID, its metadata and
 * an inline preview — nothing else", and version history + the activity feed are governed by
 * `documents.version_history`. The viewer UI honoured both, but the API did not:
 *   - GET /documents/:id returned the home folder, department, document-type and field-definition
 *     ids to a share recipient — exactly the identifiers H-1 needed;
 *   - it returned every version (with the uploader's e-mail) and the activity feed (who viewed /
 *     downloaded) to anyone with `documents.view`;
 *   - GET /documents/:id/activity needed only `documents.view`;
 *   - GET /documents/:id/file served any older version by id.
 *
 * Checked through the real HTTP stack (`app.inject`), with a positive control for each refusal: a
 * Beta member who DOES hold `documents.version_history` still gets the chain, the feed and old files.
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
const PREFIX = "zz-shrx-";
const storageDir = mkdtempSync(path.join(tmpdir(), "dms-shrx-"));

// ─────────────────────────── fixture ───────────────────────────

const owner = await prisma.user.create({
  data: { email: `${PREFIX}owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ ShareX ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
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

  async function makeDept(name: string, prefix: string) {
    const dept = await prisma.department.create({
      data: { organizationId: org.id, name, idPrefix: prefix, subfolderDepthLimit: 5 },
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
    return { dept, docType };
  }
  const alpha = await makeDept("Alpha", "ALP");
  const beta = await makeDept("Beta", "BET");
  const fieldDefId = beta.docType.fields[0].id;

  async function role(departmentId: string, name: string, keys: PermissionKey[]) {
    return prisma.role.create({
      data: { organizationId: org.id, departmentId, name, permissions: permissionMapFrom(keys) as object },
    });
  }
  const betaAdminRole = await role(beta.dept.id, "Beta Admin", [
    "documents.view", "documents.preview", "documents.download", "documents.upload", "documents.upload_version",
    "documents.edit_metadata", "documents.version_history", "sharing.share",
  ]);
  const betaReaderRole = await role(beta.dept.id, "Beta Reader", ["documents.view", "documents.preview"]);
  const betaEditorRole = await role(beta.dept.id, "Beta Editor", ["documents.view", "documents.preview", "documents.edit_metadata"]);
  const betaHistorianRole = await role(beta.dept.id, "Beta Historian", ["documents.view", "documents.preview", "documents.version_history"]);
  const alphaMemberRole = await role(alpha.dept.id, "Alpha Member", ["documents.view", "documents.preview"]);

  async function makeUser(tag: string, departmentId: string, roleId: string) {
    const user = await prisma.user.create({
      data: { email: `${PREFIX}${tag}-${stamp}@example.test`, passwordHash: "x", fullName: tag, emailVerifiedAt: new Date() },
    });
    await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId, roleId, status: "active" } });
    const token = signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false });
    return { user, auth: { authorization: `Bearer ${token}` } };
  }
  const betaAdmin = await makeUser("beta-admin", beta.dept.id, betaAdminRole.id);
  const betaReader = await makeUser("beta-reader", beta.dept.id, betaReaderRole.id);
  const betaEditor = await makeUser("beta-editor", beta.dept.id, betaEditorRole.id);
  const betaHistorian = await makeUser("beta-historian", beta.dept.id, betaHistorianRole.id);
  // The share recipient: a member of Alpha only, reached by a direct view-only share.
  const recipient = await makeUser("alpha-recipient", alpha.dept.id, alphaMemberRole.id);

  const betaFolder = await prisma.folder.create({
    data: { organizationId: org.id, departmentId: beta.dept.id, name: "Beta Contracts", parentFolderId: null, depth: 0 },
  });

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;

  function multipart(fields: Record<string, string>, fileName: string, content: Buffer) {
    const boundary = `----dmsshrx${stamp}`;
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
  const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag} ${stamp}\n%%EOF\n`);

  // Beta admin files a document, then a second version — so there is a history to leak.
  const up1Body = multipart(
    { documentTypeId: beta.docType.id, fieldValues: JSON.stringify([{ fieldDefId, value: "Vendor Contract" }]), onDuplicate: "keep_both" },
    "contract-v1.pdf",
    pdf("v1"),
  );
  const up1 = await server.inject({
    method: "POST",
    url: `/departments/${beta.dept.id}/folders/${betaFolder.id}/documents/upload`,
    headers: { ...betaAdmin.auth, ...up1Body.headers },
    payload: up1Body.payload,
  });
  check("setup: Beta admin uploads a document", up1.statusCode === 201, `${up1.statusCode} ${up1.body.slice(0, 160)}`);
  const documentId = (up1.json() as { document: { id: string } }).document.id;

  const up2Body = multipart({ changeNote: "Renegotiated terms" }, "contract-v2.pdf", pdf("v2"));
  const up2 = await server.inject({
    method: "POST",
    url: `/documents/${documentId}/versions/upload`,
    headers: { ...betaAdmin.auth, ...up2Body.headers },
    payload: up2Body.payload,
  });
  check("setup: Beta admin uploads version 2", up2.statusCode === 201, `${up2.statusCode} ${up2.body.slice(0, 160)}`);

  const versions = await prisma.version.findMany({ where: { documentId }, orderBy: { versionNumber: "asc" } });
  const v1 = versions[0];
  const v2 = versions[1];

  await prisma.share.create({
    data: {
      organizationId: org.id,
      documentId,
      sharedByUserId: betaAdmin.user.id,
      targetType: "user",
      targetUserId: recipient.user.id,
      permission: "view",
      status: "active",
    },
  });

  type Detail = {
    departmentId: string | null;
    folderId: string | null;
    documentType: { id: string | null; name: string };
    fieldValues: { fieldDefId: string | null; label: string; value: string }[];
    versions: { id: string; uploadedBy: unknown; changeNote: string | null }[];
    activity: unknown[];
    permissions: Record<string, boolean>;
  };
  async function detail(auth: Record<string, string>) {
    const res = await server.inject({ method: "GET", url: `/documents/${documentId}`, headers: auth });
    return { res, doc: res.statusCode === 200 ? (res.json() as { document: Detail }).document : null };
  }
  async function file(auth: Record<string, string>, versionId?: string) {
    return server.inject({
      method: "GET",
      url: `/documents/${documentId}/file${versionId ? `?versionId=${versionId}` : ""}`,
      headers: auth,
    });
  }
  const refused = (code: number) => code === 403 || code === 404;
  const adminEmail = betaAdmin.user.email;

  console.log("\n── view-only share recipient: the document, its metadata, a preview — nothing else ──");
  {
    const { res, doc } = await detail(recipient.auth);
    check("recipient opens the shared document", res.statusCode === 200 && doc !== null, `${res.statusCode} ${res.body.slice(0, 160)}`);
    if (doc) {
      check("…its metadata value is shown", doc.fieldValues.some((f) => f.value === "Vendor Contract" && f.label === "Title"));
      check("…its document type name is shown", doc.documentType.name === "Contract");
      check("the home folder id is NOT disclosed", !res.body.includes(betaFolder.id), "folder id in body");
      check("the home department id is NOT disclosed", !res.body.includes(beta.dept.id), "department id in body");
      check("the document-type id is NOT disclosed", !res.body.includes(beta.docType.id), "document type id in body");
      check("field-definition ids are NOT disclosed", !res.body.includes(fieldDefId), "field def id in body");
      check("only the current version is returned", doc.versions.length === 1 && doc.versions[0].id === v2.id, JSON.stringify(doc.versions.map((v) => v.id)));
      check("…and the older version's id never appears", !res.body.includes(v1.id), "v1 id in body");
      check("the uploader's e-mail is NOT disclosed", !res.body.includes(adminEmail), "uploader email in body");
      check("the change note (history) is NOT disclosed", !res.body.includes("Renegotiated terms"), "change note in body");
      check("the activity feed is empty", Array.isArray(doc.activity) && doc.activity.length === 0, JSON.stringify(doc.activity).slice(0, 160));
    }

    const act = await server.inject({ method: "GET", url: `/documents/${documentId}/activity`, headers: recipient.auth });
    check("recipient CANNOT read the activity feed endpoint", refused(act.statusCode), `${act.statusCode} ${act.body.slice(0, 120)}`);

    const cur = await file(recipient.auth);
    check("control: recipient previews the current version", cur.statusCode === 200, `${cur.statusCode}`);
    const curById = await file(recipient.auth, v2.id);
    check("control: recipient previews the current version by its id", curById.statusCode === 200, `${curById.statusCode}`);
    const old = await file(recipient.auth, v1.id);
    check("recipient CANNOT fetch an older version's bytes", refused(old.statusCode), `${old.statusCode}`);
    const dl = await server.inject({ method: "GET", url: `/documents/${documentId}/file?download=1`, headers: recipient.auth });
    check("view-only recipient CANNOT download", refused(dl.statusCode), `${dl.statusCode}`);
  }

  console.log("\n── home-department member without version history ──");
  {
    const { res, doc } = await detail(betaReader.auth);
    check("reader opens the document", res.statusCode === 200 && doc !== null, `${res.statusCode}`);
    if (doc) {
      check("control: a home member still gets the folder id (navigation)", doc.folderId === betaFolder.id, String(doc.folderId));
      check("control: …and the field-definition ids", doc.fieldValues.every((f) => f.fieldDefId === fieldDefId));
      check("only the current version is returned", doc.versions.length === 1 && doc.versions[0].id === v2.id, JSON.stringify(doc.versions.map((v) => v.id)));
      check("the uploader's e-mail is NOT disclosed", !res.body.includes(adminEmail), "uploader email in body");
      check("the activity feed is empty", doc.activity.length === 0, `${doc.activity.length} entries`);
    }
    const act = await server.inject({ method: "GET", url: `/documents/${documentId}/activity`, headers: betaReader.auth });
    check("reader CANNOT read the activity feed endpoint", refused(act.statusCode), `${act.statusCode}`);
    const old = await file(betaReader.auth, v1.id);
    check("reader CANNOT fetch an older version's bytes", refused(old.statusCode), `${old.statusCode}`);
    const cur = await file(betaReader.auth);
    check("control: reader previews the current version", cur.statusCode === 200, `${cur.statusCode}`);
  }

  console.log("\n── an action's response is shaped the same way ──");
  {
    const res = await server.inject({
      method: "PATCH",
      url: `/documents/${documentId}/metadata`,
      headers: betaEditor.auth,
      payload: { fieldValues: [{ fieldDefId, value: "Vendor Contract (signed)" }] },
    });
    check("editor (no version history) edits the metadata", res.statusCode === 200, `${res.statusCode} ${res.body.slice(0, 160)}`);
    check("…and the edit response carries no version chain or uploader", !res.body.includes(v1.id) && !res.body.includes(adminEmail), res.body.slice(0, 200));
  }

  console.log("\n── controls: a member WITH version history keeps everything ──");
  for (const [who, actor] of [["historian", betaHistorian], ["Beta admin", betaAdmin]] as const) {
    const { res, doc } = await detail(actor.auth);
    check(`${who} opens the document`, res.statusCode === 200 && doc !== null, `${res.statusCode}`);
    if (doc) {
      check(`${who} sees both versions`, doc.versions.length === 2, `${doc.versions.length}`);
      check(`${who} sees who uploaded them`, res.body.includes(adminEmail));
      check(`${who} sees the activity feed`, doc.activity.length > 0, `${doc.activity.length}`);
    }
    const act = await server.inject({ method: "GET", url: `/documents/${documentId}/activity`, headers: actor.auth });
    const entries = act.statusCode === 200 ? (act.json() as { activity: unknown[] }).activity.length : 0;
    check(`${who} reads the activity endpoint`, act.statusCode === 200 && entries > 0, `${act.statusCode} ${entries}`);
    const old = await file(actor.auth, v1.id);
    check(`${who} fetches the older version's bytes`, old.statusCode === 200, `${old.statusCode}`);
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
