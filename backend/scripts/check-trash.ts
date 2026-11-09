/**
 * Trash & recovery checks — `npm run check:trash` (backend workspace).
 *
 * Covers Module 11 (TRSH-1..4): soft-delete to trash, exclusion from normal listings, the trash view
 * (deleter + origin + countdown), restore to origin, and Department-Admin-only permanent purge that
 * deletes files + rows while the append-only audit trail survives. Uploads real files to storage.
 *
 * DEV ONLY, writes to real storage. Point it at a development environment.
 */
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { pdfBytes } from "./_fixture-files.js";
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
  data: { organizationId: org.id, name: "ZZ Trash", idPrefix: "ZZT", subfolderDepthLimit: 5 },
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
    organizationId: org.id, departmentId: dept.id, name: "Staff",
    permissions: permissionMapFrom([
      "documents.view", "documents.upload", "documents.preview", "documents.download",
      "documents.delete", "documents.restore",
    ]) as object,
  },
});
const adminRole = await prisma.role.create({
  data: {
    organizationId: org.id, departmentId: dept.id, name: "Dept Admin",
    permissions: permissionMapFrom([
      "documents.view", "documents.upload", "documents.delete", "documents.restore",
      "members.change_role", "configuration.edit_rules",
    ]) as object,
  },
});
const readerRole = await prisma.role.create({
  data: {
    organizationId: org.id, departmentId: dept.id, name: "Reader",
    permissions: permissionMapFrom(["documents.view", "documents.preview"]) as object, // no delete/restore
  },
});

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: "x", fullName: email.split("@")[0], emailVerifiedAt: new Date() } });
}
const staffU = await makeUser("zz-trash-staff@example.test");
await prisma.membership.create({ data: { organizationId: org.id, userId: staffU.id, departmentId: dept.id, roleId: staffRole.id, status: "active" } });
const staff: PermissionActor = { userId: staffU.id, organizationId: org.id, isSuperAdmin: false };

const adminU = await makeUser("zz-trash-admin@example.test");
await prisma.membership.create({ data: { organizationId: org.id, userId: adminU.id, departmentId: dept.id, roleId: adminRole.id, status: "active" } });
const admin: PermissionActor = { userId: adminU.id, organizationId: org.id, isSuperAdmin: false };

const readerU = await makeUser("zz-trash-reader@example.test");
await prisma.membership.create({ data: { organizationId: org.id, userId: readerU.id, departmentId: dept.id, roleId: readerRole.id, status: "active" } });
const reader: PermissionActor = { userId: readerU.id, organizationId: org.id, isSuperAdmin: false };

const folder = await prisma.folder.create({ data: { organizationId: org.id, departmentId: dept.id, name: "General", depth: 0 } });

async function upload(tag: string) {
  const bytes = pdfBytes(`zz trash ${tag} ${Date.now()} ${Math.random()}`);
  const up = await uploads.uploadDocument(fileDeps, staff, {
    departmentId: dept.id, folderId: folder.id, documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: docType.fields[0].id, value: `Doc ${tag}` }],
    file: { fileName: `${tag}.pdf`, declaredMime: "application/pdf", data: bytes },
  });
  return up.document!.id;
}

try {
  const docId = await upload("A");

  // ── delete moves to trash (TRSH-1) ──
  await expectError("a reader without delete rights can't delete", "forbidden", () =>
    documents.deleteDocument(deps, reader, docId),
  );
  const del = await documents.deleteDocument(deps, staff, docId);
  check("delete moves the document to trash", del.status === "in_trash");
  check("a trashed document leaves the folder listing", !(await documents.listFolderDocuments(deps, staff, folder.id)).some((d) => d.id === docId));

  // ── the trash view (TRSH-2) ──
  const trash = await documents.listTrash(deps, staff, dept.id);
  const item = trash.find((t) => t.id === docId);
  check("the item shows in trash with who deleted it", item?.deletedByName === staffU.fullName);
  check("with its origin folder", item?.originFolderName === "General");
  check("and an auto-remove countdown", (item?.daysUntilAutoRemove ?? 0) >= 29 && (item?.daysUntilAutoRemove ?? 0) <= 30);

  // ── restore to origin (TRSH-2) ──
  const restored = await documents.restoreDocument(deps, staff, docId);
  check("restore returns it to active", restored.status === "active");
  check("with its ID and folder intact", restored.documentRef === (await prisma.document.findUniqueOrThrow({ where: { id: docId } })).documentRef);
  check("and it's back in the folder listing", (await documents.listFolderDocuments(deps, staff, folder.id)).some((d) => d.id === docId));
  await expectError("restoring an active document is refused", "not_in_trash", () =>
    documents.restoreDocument(deps, staff, docId),
  );

  // ── purge is Department-Admin only (TRSH-3) ──
  await documents.deleteDocument(deps, staff, docId);
  await expectError("staff can't purge (not a Department Admin)", "forbidden", () =>
    documents.purgeDocument(fileDeps, staff, docId),
  );
  const storageRefs = (await prisma.version.findMany({ where: { documentId: docId }, select: { storageRef: true } })).map((v) => v.storageRef);
  await documents.purgeDocument(fileDeps, admin, docId);
  check("purge truly deletes the document", (await prisma.document.findUnique({ where: { id: docId } })) === null);
  check("purge deletes its versions", (await prisma.version.count({ where: { documentId: docId } })) === 0);

  const driver = await getActiveStorageDriver(fileDeps, org.id);
  let filesGone = true;
  for (const ref of storageRefs) {
    try { await driver.get(ref); filesGone = false; } catch { /* gone, as expected */ }
  }
  check("purge deletes the stored files", filesGone);

  // ── the append-only audit trail survives a purge ──
  const purgeEvent = await prisma.auditEvent.findFirst({
    where: { departmentId: dept.id, action: "delete", targetDescription: { contains: "Permanently deleted" } },
  });
  check("the purge is still in the audit trail", Boolean(purgeEvent));
  check("its document link is nulled, not the row deleted", purgeEvent?.documentId === null);

  // ── empty trash (TRSH-3) ──
  const d1 = await upload("B");
  const d2 = await upload("C");
  await documents.deleteDocument(deps, staff, d1);
  await documents.deleteDocument(deps, staff, d2);
  await expectError("staff can't empty the trash", "forbidden", () =>
    documents.emptyTrash(fileDeps, staff, dept.id),
  );
  const emptied = await documents.emptyTrash(fileDeps, admin, dept.id);
  check("empty trash purges everything in it", emptied.purged === 2);
  check("and the trash is now empty", (await documents.listTrash(deps, staff, dept.id)).length === 0);
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  try {
    const driver = await getActiveStorageDriver(fileDeps, org.id);
    const versions = await prisma.version.findMany({ where: { document: { departmentId: dept.id } }, select: { storageRef: true, fileSize: true } });
    let total = 0;
    for (const v of versions) { total += v.fileSize; await driver.delete(v.storageRef).catch(() => {}); }
    if (total > 0) await prisma.storageConfig.updateMany({ where: { organizationId: org.id }, data: { usedBytes: { decrement: BigInt(total) } } });
  } catch (err) {
    console.error("[cleanup] storage issue:", err);
  }
  await purgeTestAuditEvents(prisma, { where: { departmentId: dept.id } });
  await prisma.fieldValue.deleteMany({ where: { document: { departmentId: dept.id } } });
  await prisma.share.deleteMany({ where: { document: { departmentId: dept.id } } });
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
  await prisma.user.deleteMany({ where: { id: { in: [staffU.id, adminU.id, readerU.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
