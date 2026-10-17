/**
 * Document-module checks — `npm run check:documents` (backend workspace).
 *
 * Covers Module 5 (DOC-1..DOC-6): the DEPT-TYPE-YYYY-NNNNN ID generator, field-value validation,
 * versioning that never overwrites, restore that copies forward, exact-ID lookup, and the
 * identity-based permission gating for reading/acting on a document.
 *
 * DEV ONLY, and it writes: creates a throwaway department ("ZZ Document Test"), two throwaway
 * users, folders, and documents, then deletes all of it. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import * as documents from "../src/modules/document/document.service.js";
import { DocumentError } from "../src/modules/document/document.service.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const deps = { prisma };
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

const year = new Date().getFullYear();
const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });
const superAdmin: PermissionActor = {
  userId: org.createdByUserId,
  organizationId: org.id,
  isSuperAdmin: true,
};

// ── fixture: department, a Contract type with a full field set, roles, users, a folder ──
const dept = await prisma.department.create({
  data: {
    organizationId: org.id,
    name: "ZZ Document Test",
    idPrefix: "ZZD",
    subjectTerm: "Contract",
    identifierTerm: "Employee ID",
    subfolderDepthLimit: 5,
  },
});

const docType = await prisma.documentType.create({
  data: {
    departmentId: dept.id,
    name: "Contract",
    idCode: "CON",
    fields: {
      create: [
        { label: "Name", fieldType: "text", isRequired: true, isTitle: true, sortOrder: 0 },
        { label: "Status", fieldType: "dropdown", options: ["Draft", "Signed"], sortOrder: 1 },
        { label: "Employee ID", fieldType: "id", isRequired: true, sortOrder: 2 },
        { label: "Amount", fieldType: "number", sortOrder: 3 },
        { label: "Start date", fieldType: "date", sortOrder: 4 },
      ],
    },
  },
  include: { fields: true },
});
const F = (label: string) => docType.fields.find((f) => f.label === label)!.id;

// A type belonging to a *different* department, to prove the folder/type department check.
const otherDept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Document Test 2", idPrefix: "ZZE" },
});
const foreignType = await prisma.documentType.create({
  data: {
    departmentId: otherDept.id,
    name: "Memo",
    idCode: "MEM",
    fields: { create: [{ label: "Title", fieldType: "text", isRequired: true, isTitle: true, sortOrder: 0 }] },
  },
});

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
      "documents.download",
      "documents.preview",
      "documents.version_history",
    ]) as object,
  },
});
const viewerRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Viewer",
    permissions: permissionMapFrom(["documents.view", "documents.preview", "documents.download"]) as object,
  },
});

const uploaderUser = await prisma.user.findFirstOrThrow({ where: { email: "ada@example.com" } });
await prisma.membership.create({
  data: { organizationId: org.id, userId: uploaderUser.id, departmentId: dept.id, roleId: staffRole.id, status: "active" },
});
const uploader: PermissionActor = { userId: uploaderUser.id, organizationId: org.id, isSuperAdmin: false };

const viewerUser = await prisma.user.create({
  data: { email: "zz-doc-viewer@example.test", passwordHash: "x", fullName: "ZZ Viewer", emailVerifiedAt: new Date() },
});
await prisma.membership.create({
  data: { organizationId: org.id, userId: viewerUser.id, departmentId: dept.id, roleId: viewerRole.id, status: "active" },
});
const viewer: PermissionActor = { userId: viewerUser.id, organizationId: org.id, isSuperAdmin: false };

const strangerUser = await prisma.user.create({
  data: { email: "zz-doc-stranger@example.test", passwordHash: "x", fullName: "ZZ Stranger", emailVerifiedAt: new Date() },
});
const stranger: PermissionActor = { userId: strangerUser.id, organizationId: org.id, isSuperAdmin: false };

const folder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Contracts", depth: 0 },
});

const file = (n: number) => ({
  storageRef: `dev/throwaway/${n}`,
  fileName: `contract-${n}.pdf`,
  fileSize: 1024 * n,
  mimeType: "application/pdf",
});

const validValues = [
  { fieldDefId: F("Name"), value: "Acme MSA" },
  { fieldDefId: F("Status"), value: "Signed" },
  { fieldDefId: F("Employee ID"), value: "E-100" },
  { fieldDefId: F("Amount"), value: "5000" },
  { fieldDefId: F("Start date"), value: "2026-01-15" },
];

// ── ID generation (DOC-1) ──
const doc1 = await documents.createDocument(deps, uploader, {
  folderId: folder.id,
  documentTypeId: docType.id,
  fieldValues: validValues,
  file: file(1),
});
check("document ID has the DEPT-TYPE-YYYY-NNNNN format", doc1.documentRef === `ZZD-CON-${year}-00001`, doc1.documentRef);
check("title is derived from the title field", doc1.titleValue === "Acme MSA");
check("first version is created and current", doc1.versions.length === 1 && doc1.versions[0].isCurrent && doc1.currentVersionId === doc1.versions[0].id);
check("all field values are stored", doc1.fieldValues.length === 5);

const doc2 = await documents.createDocument(deps, uploader, {
  folderId: folder.id,
  documentTypeId: docType.id,
  fieldValues: [
    { fieldDefId: F("Name"), value: "Beta NDA" },
    { fieldDefId: F("Employee ID"), value: "E-101" },
  ],
  file: file(2),
});
check("the sequence increments per document", doc2.documentRef === `ZZD-CON-${year}-00002`, doc2.documentRef);

// ── field validation ──
await expectError("a missing required field is refused", "missing_required_field", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: F("Name"), value: "No emp id" }],
    file: file(3),
  }),
);
await expectError("an off-list dropdown value is refused", "invalid_option", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [
      { fieldDefId: F("Name"), value: "X" },
      { fieldDefId: F("Employee ID"), value: "E-1" },
      { fieldDefId: F("Status"), value: "Pending" },
    ],
    file: file(3),
  }),
);
await expectError("a non-numeric number is refused", "invalid_number", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [
      { fieldDefId: F("Name"), value: "X" },
      { fieldDefId: F("Employee ID"), value: "E-1" },
      { fieldDefId: F("Amount"), value: "lots" },
    ],
    file: file(3),
  }),
);
await expectError("an invalid date is refused", "invalid_date", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [
      { fieldDefId: F("Name"), value: "X" },
      { fieldDefId: F("Employee ID"), value: "E-1" },
      { fieldDefId: F("Start date"), value: "not-a-date" },
    ],
    file: file(3),
  }),
);
await expectError("a field from another type is refused", "unknown_field", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: foreignType.id, value: "x" }],
    file: file(3),
  }),
);
await expectError("a duplicated field is refused", "duplicate_field", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [
      { fieldDefId: F("Name"), value: "A" },
      { fieldDefId: F("Name"), value: "B" },
      { fieldDefId: F("Employee ID"), value: "E-1" },
    ],
    file: file(3),
  }),
);
await expectError("a document type from another department is refused", "document_type_mismatch", () =>
  documents.createDocument(deps, uploader, {
    folderId: folder.id,
    documentTypeId: foreignType.id,
    fieldValues: [],
    file: file(3),
  }),
);
check("no partial documents leaked from the failed creates", (await prisma.document.count({ where: { folderId: folder.id } })) === 2);
check("no sequence numbers were burned by failed creates", (await prisma.documentRefSequence.findFirstOrThrow({ where: { departmentId: dept.id } })).lastNumber === 2);

// ── versioning: never overwrite (DOC-4) ──
const v2 = await documents.addVersion(deps, uploader, doc1.id, { file: file(9), changeNote: "Signed copy" });
check("a new version is added, not overwritten", v2.versions.length === 2);
check("the newest version becomes current", v2.versions[1].isCurrent && !v2.versions[0].isCurrent);
check("the ID and title carry over unchanged", v2.documentRef === doc1.documentRef && v2.titleValue === "Acme MSA");
check("the change note labels the version", v2.versions[1].changeNote === "Signed copy");

// ── restore copies forward (DOC-5) ──
const firstVersionId = doc1.versions[0].id;
const restored = await documents.restoreVersion(deps, uploader, doc1.id, firstVersionId);
check("restoring copies the chosen version forward as a new one", restored.versions.length === 3);
check("intervening versions are retained", restored.versions.map((v) => v.versionNumber).join(",") === "1,2,3");
check("the restored copy is current", restored.versions[2].isCurrent && restored.currentVersionId === restored.versions[2].id);
check("the restored copy reuses the source file", restored.versions[2].fileName === doc1.versions[0].fileName);
check("the restored copy is labelled", restored.versions[2].changeNote === "Restored from v1");

await expectError("restoring the already-current version is refused", "already_current", () =>
  documents.restoreVersion(deps, uploader, doc1.id, restored.currentVersionId!),
);
await expectError("restoring an unknown version is refused", "version_not_found", () =>
  documents.restoreVersion(deps, uploader, doc1.id, "00000000-0000-0000-0000-000000000000"),
);

// ── exact-ID lookup (DOC-3) ──
const found = await documents.lookupByRef(deps, uploader, doc1.documentRef);
check("an exact ID lookup resolves to the document", found.documentId === doc1.id && found.folderId === folder.id);
await expectError("an unknown ID is not found", "document_not_found", () =>
  documents.lookupByRef(deps, uploader, "ZZD-CON-1999-00001"),
);

// ── edit metadata ──
const edited = await documents.editMetadata(deps, uploader, doc1.id, [
  { fieldDefId: F("Name"), value: "Acme MSA (renamed)" },
  { fieldDefId: F("Employee ID"), value: "E-100" },
]);
check("editing metadata updates the title", edited.titleValue === "Acme MSA (renamed)");
check("editing metadata replaces the field values", edited.fieldValues.length === 2);
check("editing metadata never changes the ID", edited.documentRef === doc1.documentRef);

// ── permission gating (identity-based) ──
const viewerGet = await documents.getDocument(deps, viewer, doc1.id);
check("a viewer with documents.view can read the document", viewerGet.id === doc1.id);
await expectError("a viewer without upload_version can't restore (403)", "forbidden", () =>
  documents.restoreVersion(deps, viewer, doc1.id, firstVersionId),
);
await expectError("a viewer without edit_metadata can't edit (403)", "forbidden", () =>
  documents.editMetadata(deps, viewer, doc1.id, validValues),
);
await expectError("a non-member can't read the document (404, no leak)", "document_not_found", () =>
  documents.getDocument(deps, stranger, doc1.id),
);
await expectError("a non-member's ID lookup returns not-found (no leak)", "document_not_found", () =>
  documents.lookupByRef(deps, stranger, doc1.documentRef),
);

// ── confidential boundary applies to documents too ──
const vault = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Vault", depth: 0, isConfidential: true },
});
// The uploader is a named member of the vault, so their role resolves inside it and they can file.
await prisma.confidentialMember.create({ data: { folderId: vault.id, userId: uploaderUser.id, isOwner: true } });
const secret = await documents.createDocument(deps, uploader, {
  folderId: vault.id,
  documentTypeId: docType.id,
  fieldValues: [
    { fieldDefId: F("Name"), value: "Sealed" },
    { fieldDefId: F("Employee ID"), value: "E-999" },
  ],
  file: file(20),
});
const namedGet = await documents.getDocument(deps, uploader, secret.id);
check("a named confidential member can read the confidential document", namedGet.id === secret.id);
await expectError("a department viewer NOT on the named list can't read it (404)", "document_not_found", () =>
  documents.getDocument(deps, viewer, secret.id),
);
await expectError("nor find it by ID", "document_not_found", () =>
  documents.lookupByRef(deps, viewer, secret.documentRef),
);
await expectError("Super Admin is excluded from the confidential document too", "document_not_found", () =>
  documents.getDocument(deps, superAdmin, secret.id),
);

// ── folder listing ──
const listed = await documents.listFolderDocuments(deps, uploader, folder.id);
check("the folder listing returns its active documents", listed.length === 2 && listed.every((d) => d.documentRef.startsWith("ZZD-CON-")));

// ── teardown ──
await prisma.fieldValue.deleteMany({ where: { document: { departmentId: dept.id } } });
await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
// A document points at its current version and each version points back — null the pointer first
// so neither delete trips the other's foreign key.
await prisma.document.updateMany({ where: { departmentId: dept.id }, data: { currentVersionId: null } });
await prisma.version.deleteMany({ where: { document: { departmentId: dept.id } } });
await prisma.document.deleteMany({ where: { departmentId: dept.id } });
await prisma.documentRefSequence.deleteMany({ where: { departmentId: dept.id } });
await prisma.confidentialMember.deleteMany({ where: { folder: { departmentId: dept.id } } });
await prisma.folder.deleteMany({ where: { departmentId: dept.id } });
await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
await prisma.fieldDef.deleteMany({ where: { documentType: { departmentId: { in: [dept.id, otherDept.id] } } } });
await prisma.documentType.deleteMany({ where: { departmentId: { in: [dept.id, otherDept.id] } } });
await prisma.role.deleteMany({ where: { departmentId: dept.id } });
await prisma.department.deleteMany({ where: { id: { in: [dept.id, otherDept.id] } } });
await prisma.user.deleteMany({ where: { id: { in: [viewerUser.id, strangerUser.id] } } });

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
