/**
 * Upload-module checks — `npm run check:upload` (backend workspace).
 *
 * Exercises the upload service end-to-end against the real database AND the org's real storage
 * backend (Abate's verified R2): store → duplicate detection → new-version / keep-both / skip →
 * never-block incomplete save → needs-details queue → format and size rejection. Every stored
 * object and every DB row is removed afterwards (in a finally block), and the org's recorded
 * storage usage is reverted, so the real org is left exactly as it was.
 *
 * DEV ONLY, and it writes to real storage. Point it at a development environment.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as uploads from "../src/modules/upload/upload.service.js";
import { UploadError } from "../src/modules/upload/upload.service.js";
import * as documents from "../src/modules/document/document.service.js";
import { getActiveStorageDriver } from "../src/modules/storage/storage.service.js";
import { getOcrQueue } from "../src/lib/queue.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma, env };
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
    const actual = err instanceof UploadError ? err.code : String(err);
    check(label, actual === code, `expected ${code}, got ${actual}`);
  }
}

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });

const dept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Upload Test", idPrefix: "ZZU", subfolderDepthLimit: 5 },
});
const docType = await prisma.documentType.create({
  data: {
    departmentId: dept.id,
    name: "Contract",
    idCode: "CON",
    fields: {
      create: [
        { label: "Name", fieldType: "text", isRequired: true, isTitle: true, sortOrder: 0 },
        { label: "Employee ID", fieldType: "id", isRequired: true, sortOrder: 1 },
      ],
    },
  },
  include: { fields: true },
});
const F = (label: string) => docType.fields.find((f) => f.label === label)!.id;
const staffRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Staff",
    permissions: permissionMapFrom([
      "documents.view",
      "documents.upload",
      "documents.upload_version",
      "documents.edit_metadata",
    ]) as object,
  },
});
const uploaderUser = await prisma.user.findFirstOrThrow({ where: { email: "ada@example.com" } });
await prisma.membership.create({
  data: { organizationId: org.id, userId: uploaderUser.id, departmentId: dept.id, roleId: staffRole.id, status: "active" },
});
const uploader: PermissionActor = { userId: uploaderUser.id, organizationId: org.id, isSuperAdmin: false };
const folder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Contracts", depth: 0 },
});

const nameVal = (v: string) => [
  { fieldDefId: F("Name"), value: v },
  { fieldDefId: F("Employee ID"), value: "E-100" },
];

// Arbitrary bytes; format is resolved from the extension, so a real PDF/DOCX byte stream isn't
// needed to exercise storage, checksum, duplicate detection and metadata.
const docxBytes = Buffer.from("PK\u0003\u0004 zz upload test docx payload " + Date.now());
const docxFile = { fileName: "contract-a.docx", declaredMime: "application/octet-stream", data: docxBytes };

try {
  // ── a first upload creates a document and stores the file ──
  const first = await uploads.uploadDocument(deps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: nameVal("Acme MSA"),
    file: docxFile,
  });
  check("a new upload creates a document", first.action === "created" && !!first.document);
  const doc1 = first.document!;
  check("the title is set from metadata", doc1.titleValue === "Acme MSA");
  check("a docx is marked ocr done (nothing to extract)", doc1.versions[0].ocrStatus === "done");

  // storage round-trip: the stored object reads back byte-identical
  const driver = await getActiveStorageDriver(deps, org.id);
  const stored = await prisma.version.findFirstOrThrow({ where: { documentId: doc1.id } });
  const readBack = await driver.get(stored.storageRef);
  check("the stored file reads back byte-identical", Buffer.from(readBack).equals(docxBytes));
  check("a checksum was recorded", !!stored.checksum && stored.checksum.length === 64);

  // ── duplicate detection (UPL-4) ──
  await expectError("an identical file is refused pending a choice", "duplicate_detected", () =>
    uploads.uploadDocument(deps, uploader, {
      departmentId: dept.id,
      folderId: folder.id,
      documentTypeId: docType.id,
      fieldValues: nameVal("Dup"),
      file: docxFile,
    }),
  );

  const skipped = await uploads.uploadDocument(deps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: nameVal("Dup"),
    file: docxFile,
    onDuplicate: "skip",
  });
  check("skip stores nothing", skipped.action === "skipped");

  const asVersion = await uploads.uploadDocument(deps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: nameVal("Dup"),
    file: docxFile,
    onDuplicate: "new_version",
    duplicateOfDocumentId: doc1.id,
  });
  check("add-as-new-version adds a version to the original", asVersion.action === "new_version" && asVersion.document!.versions.length === 2);
  check("and does not change the document ID", asVersion.document!.documentRef === doc1.documentRef);

  const keepBoth = await uploads.uploadDocument(deps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: nameVal("Copy"),
    file: docxFile,
    onDuplicate: "keep_both",
  });
  check("keep-both creates a separate document", keepBoth.action === "created" && keepBoth.document!.id !== doc1.id);

  // ── never block: incomplete save + needs-details queue (UPL-5) ──
  const incomplete = await uploads.uploadDocument(deps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [], // both required fields missing — must still save
    file: { fileName: "incomplete.docx", declaredMime: "application/octet-stream", data: Buffer.from("zz incomplete " + Date.now()) },
  });
  check("an upload missing required fields still saves", incomplete.action === "created");
  const needs = await documents.listNeedsDetails(deps, uploader, dept.id);
  const flagged = needs.find((n) => n.id === incomplete.document!.id);
  check("the incomplete document appears in needs-details", !!flagged);
  check("needs-details names the missing required fields", !!flagged && flagged.missingFields.includes("Name") && flagged.missingFields.includes("Employee ID"));

  await documents.editMetadata(deps, uploader, incomplete.document!.id, nameVal("Now complete"));
  const needsAfter = await documents.listNeedsDetails(deps, uploader, dept.id);
  check("completing the metadata clears it from needs-details", !needsAfter.some((n) => n.id === incomplete.document!.id));

  // ── format and size rejection (UPL-7) ──
  await expectError("an unsupported format is refused", "unsupported_format", () =>
    uploads.uploadDocument(deps, uploader, {
      departmentId: dept.id,
      folderId: folder.id,
      documentTypeId: docType.id,
      fieldValues: nameVal("Bad"),
      file: { fileName: "notes.txt", declaredMime: "text/plain", data: Buffer.from("hello") },
    }),
  );
  await expectError("a file over the size limit is refused", "file_too_large", () =>
    uploads.uploadDocument(
      { prisma, env: { ...env, MAX_UPLOAD_BYTES: 8 } },
      uploader,
      {
        departmentId: dept.id,
        folderId: folder.id,
        documentTypeId: docType.id,
        fieldValues: nameVal("Big"),
        file: { fileName: "big.pdf", declaredMime: "application/pdf", data: Buffer.from("way more than eight bytes") },
      },
    ),
  );

  // ── a pdf is queued for OCR (status pending, worker will pick it up) ──
  const pdf = await uploads.uploadDocument(deps, uploader, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: nameVal("Scanned"),
    file: { fileName: "scan.pdf", declaredMime: "application/pdf", data: Buffer.from("%PDF-1.4 zz " + Date.now()) },
  });
  check("a pdf upload is left pending for the OCR worker", pdf.document!.versions[0].ocrStatus === "pending");
} finally {
  // ── teardown: remove stored objects from real storage, revert usage, drop DB rows ──
  try {
    const driver = await getActiveStorageDriver(deps, org.id);
    const versions = await prisma.version.findMany({ where: { document: { departmentId: dept.id } }, select: { storageRef: true, fileSize: true } });
    let bytes = 0;
    for (const v of versions) {
      bytes += v.fileSize;
      await driver.delete(v.storageRef).catch(() => {});
    }
    await prisma.storageConfig.updateMany({ where: { organizationId: org.id }, data: { usedBytes: { decrement: BigInt(bytes) } } });
    console.log(`\n[cleanup] removed ${versions.length} stored object(s), reverted ${bytes} bytes of usage`);
  } catch (err) {
    console.error("[cleanup] storage cleanup issue (objects may remain):", err);
  }

  await prisma.fieldValue.deleteMany({ where: { document: { departmentId: dept.id } } });
  await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
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

  // Clear the OCR jobs this run queued and close the queue connection so the process can exit.
  try {
    const q = getOcrQueue(env);
    await q.obliterate({ force: true });
    await q.close();
  } catch { /* queue may be unreachable — nothing to clean */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
