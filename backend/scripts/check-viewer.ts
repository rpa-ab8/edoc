/**
 * Viewer-module checks — `npm run check:viewer` (backend workspace).
 *
 * Covers Module 8's backend: the detail payload (permissions + activity + a logged view), the
 * activity feed, and file serving for preview/download with permission gating (VUE-1/4/5). Uploads a
 * real file to the org's storage, then deletes it and reverts usage.
 *
 * DEV ONLY, writes to real storage. Point it at a development environment.
 */
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { docxBytes } from "./_fixture-files.js";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as uploads from "../src/modules/upload/upload.service.js";
import * as documents from "../src/modules/document/document.service.js";
import { DocumentError } from "../src/modules/document/document.service.js";
import { getActiveStorageDriver } from "../src/modules/storage/storage.service.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma };
const fileDeps = { prisma, env };
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
    const actual = err instanceof DocumentError ? err.code : String(err);
    check(label, actual === code, `expected ${code}, got ${actual}`);
  }
}

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });

const dept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Viewer Test", idPrefix: "ZZV", subfolderDepthLimit: 5 },
});
const docType = await prisma.documentType.create({
  data: {
    departmentId: dept.id,
    name: "Doc",
    idCode: "DOC",
    fields: { create: [{ label: "Name", fieldType: "text", isTitle: true, sortOrder: 0 }] },
  },
  include: { fields: true },
});
const staffRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Staff",
    permissions: permissionMapFrom([
      "documents.view",
      "documents.upload",
      "documents.preview",
      "documents.download",
      "documents.edit_metadata",
      "documents.version_history",
    ]) as object,
  },
});
const viewerRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Read only",
    permissions: permissionMapFrom(["documents.view", "documents.preview"]) as object, // no download
  },
});
const uploaderUser = await prisma.user.findFirstOrThrow({ where: { email: "ada@example.com" } });
await prisma.membership.create({ data: { organizationId: org.id, userId: uploaderUser.id, departmentId: dept.id, roleId: staffRole.id, status: "active" } });
const uploader: PermissionActor = { userId: uploaderUser.id, organizationId: org.id, isSuperAdmin: false };

const viewerUser = await prisma.user.create({ data: { email: "zz-viewer@example.test", passwordHash: "x", fullName: "ZZ Viewer", emailVerifiedAt: new Date() } });
await prisma.membership.create({ data: { organizationId: org.id, userId: viewerUser.id, departmentId: dept.id, roleId: viewerRole.id, status: "active" } });
const viewer: PermissionActor = { userId: viewerUser.id, organizationId: org.id, isSuperAdmin: false };

const strangerUser = await prisma.user.create({ data: { email: "zz-viewer-stranger@example.test", passwordHash: "x", fullName: "ZZ Stranger", emailVerifiedAt: new Date() } });
const stranger: PermissionActor = { userId: strangerUser.id, organizationId: org.id, isSuperAdmin: false };

const folder = await prisma.folder.create({ data: { organizationId: org.id, departmentId: dept.id, name: "General", depth: 0 } });

const bytes = docxBytes("zz viewer test payload " + Date.now());

try {
  const up = await uploads.uploadDocument(fileDeps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: docType.fields[0].id, value: "Viewer Doc" }],
    file: { fileName: "viewer.docx", declaredMime: "application/octet-stream", data: bytes },
  });
  const docId = up.document!.id;

  // ── detail payload (permissions + activity + a logged view) ──
  const detail = await documents.getDocument(deps, uploader, docId);
  check("detail returns the caller's permissions", detail.permissions["documents.download"] === true);
  check("opening the viewer logs a view", detail.activity.some((a) => a.action === "view"));
  check("the upload event is in the activity feed", detail.activity.some((a) => a.action === "upload"));

  const activity = await documents.getDocumentActivity(deps, uploader, docId);
  check("the activity endpoint returns events", activity.length >= 2);

  // ── file serving (preview / download) ──
  const preview = await documents.getDocumentFile(fileDeps, uploader, docId, undefined, "preview");
  check("preview returns the stored bytes", Buffer.from(preview.buffer).equals(bytes) && preview.fileName === "viewer.docx");

  const download = await documents.getDocumentFile(fileDeps, uploader, docId, undefined, "download");
  check("download returns the stored bytes", Buffer.from(download.buffer).equals(bytes));
  const afterDownload = await documents.getDocumentActivity(deps, uploader, docId);
  check("a download is recorded in the activity feed", afterDownload.some((a) => a.action === "download"));

  // ── permission gating (VUE-5) ──
  const viewerDetail = await documents.getDocument(deps, viewer, docId);
  check("a read-only viewer has no download permission", viewerDetail.permissions["documents.download"] !== true);
  check("but can preview", (await documents.getDocumentFile(fileDeps, viewer, docId, undefined, "preview")).fileName === "viewer.docx");
  await expectError("a read-only viewer can't download (403)", "forbidden", () =>
    documents.getDocumentFile(fileDeps, viewer, docId, undefined, "download"),
  );
  await expectError("a non-member can't open the document (404)", "document_not_found", () =>
    documents.getDocument(deps, stranger, docId),
  );
  await expectError("nor fetch its file", "document_not_found", () =>
    documents.getDocumentFile(fileDeps, stranger, docId, undefined, "preview"),
  );
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  try {
    const driver = await getActiveStorageDriver(fileDeps, org.id);
    const versions = await prisma.version.findMany({ where: { document: { departmentId: dept.id } }, select: { storageRef: true, fileSize: true } });
    let total = 0;
    for (const v of versions) {
      total += v.fileSize;
      await driver.delete(v.storageRef).catch(() => {});
    }
    await prisma.storageConfig.updateMany({ where: { organizationId: org.id }, data: { usedBytes: { decrement: BigInt(total) } } });
    console.log(`\n[cleanup] removed ${versions.length} object(s), reverted ${total} bytes`);
  } catch (err) {
    console.error("[cleanup] storage issue:", err);
  }
  await prisma.fieldValue.deleteMany({ where: { document: { departmentId: dept.id } } });
  await purgeTestAuditEvents(prisma, { where: { departmentId: dept.id } });
  await prisma.document.updateMany({ where: { departmentId: dept.id }, data: { currentVersionId: null } });
  await prisma.version.deleteMany({ where: { document: { departmentId: dept.id } } });
  await prisma.document.deleteMany({ where: { departmentId: dept.id } });
  await prisma.documentRefSequence.deleteMany({ where: { departmentId: dept.id } });
  await prisma.folder.deleteMany({ where: { departmentId: dept.id } });
  await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
  await prisma.fieldDef.deleteMany({ where: { documentType: { departmentId: dept.id } } });
  await prisma.documentType.deleteMany({ where: { departmentId: dept.id } });
  await prisma.role.deleteMany({ where: { departmentId: dept.id } });
  await prisma.department.deleteMany({ where: { id: dept.id } });
  await prisma.user.deleteMany({ where: { id: { in: [viewerUser.id, strangerUser.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
