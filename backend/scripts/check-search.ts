/**
 * Search-module checks — `npm run check:search` (backend workspace).
 *
 * Exercises SRCH-1..5 against a real database: the tsvector text search (title / field value /
 * filename / OCR text, with prefix matching), the per-field filters (contains / exact / dropdown-in
 * / date range / number range), document-type scoping, quick views, most-recent-first ordering, and
 * the confidential-folder exclusion. Documents are created through Module 5's `createDocument` with
 * stand-in storage refs and simulated OCR text (no real storage), then everything is deleted.
 *
 * DEV ONLY, and it writes. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import * as documents from "../src/modules/document/document.service.js";
import { searchDocuments } from "../src/modules/search/search.service.js";
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
const refs = (rs: { documentRef: string }[]) => rs.map((r) => r.documentRef).sort().join(",");

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });
const superAdmin: PermissionActor = { userId: org.createdByUserId, organizationId: org.id, isSuperAdmin: true };

const dept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Search Test", idPrefix: "ZZS", subfolderDepthLimit: 5 },
});

async function makeType(name: string, idCode: string) {
  return prisma.documentType.create({
    data: {
      departmentId: dept.id,
      name,
      idCode,
      fields: {
        create: [
          { label: "Name", fieldType: "text", isTitle: true, isFilterable: true, sortOrder: 0 },
          { label: "Vendor", fieldType: "text", isFilterable: true, sortOrder: 1 },
          { label: "Status", fieldType: "dropdown", options: ["Open", "Closed"], isFilterable: true, sortOrder: 2 },
          { label: "Amount", fieldType: "number", isFilterable: true, sortOrder: 3 },
          { label: "Due date", fieldType: "date", isFilterable: true, sortOrder: 4 },
        ],
      },
    },
    include: { fields: true },
  });
}
const invoice = await makeType("Invoice", "INV");
const receipt = await makeType("Receipt", "RCP");
const F = (t: typeof invoice, label: string) => t.fields.find((f) => f.label === label)!.id;

const role = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Staff",
    permissions: permissionMapFrom(["documents.view", "documents.upload", "search.search"]) as object,
  },
});
const uploaderUser = await prisma.user.findFirstOrThrow({ where: { email: "ada@example.com" } });
await prisma.membership.create({
  data: { organizationId: org.id, userId: uploaderUser.id, departmentId: dept.id, roleId: role.id, status: "active" },
});
const uploader: PermissionActor = { userId: uploaderUser.id, organizationId: org.id, isSuperAdmin: false };

const viewerUser = await prisma.user.create({
  data: { email: "zz-search-viewer@example.test", passwordHash: "x", fullName: "ZZ Search Viewer", emailVerifiedAt: new Date() },
});
await prisma.membership.create({
  data: { organizationId: org.id, userId: viewerUser.id, departmentId: dept.id, roleId: role.id, status: "active" },
});
const viewer: PermissionActor = { userId: viewerUser.id, organizationId: org.id, isSuperAdmin: false };

const folder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Docs", depth: 0 },
});

let n = 0;
const file = (name: string, ocrText?: string) => ({
  storageRef: `dev/search/${++n}`,
  fileName: name,
  fileSize: 1000 + n,
  mimeType: name.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ocrStatus: (ocrText ? "done" : "pending") as "done" | "pending",
  ocrText: ocrText ?? null,
});
const vals = (t: typeof invoice, v: Record<string, string>) =>
  Object.entries(v).map(([label, value]) => ({ fieldDefId: F(t, label), value }));

// doc1 — Invoice, Acme, Open, 5000, 2026-03-15, OCR "widgets"
const doc1 = await documents.createDocument(deps, uploader, {
  folderId: folder.id, documentTypeId: invoice.id,
  fieldValues: vals(invoice, { Name: "Acme Invoice", Vendor: "Acme Corp", Status: "Open", Amount: "5000", "Due date": "2026-03-15" }),
  file: file("acme-invoice.pdf", "payment terms net thirty for widgets and sprockets"),
});
// doc2 — Receipt, Beta, Closed, 250, 2026-06-01, OCR "refund"
const doc2 = await documents.createDocument(deps, uploader, {
  folderId: folder.id, documentTypeId: receipt.id,
  fieldValues: vals(receipt, { Name: "Beta Receipt", Vendor: "Beta LLC", Status: "Closed", Amount: "250", "Due date": "2026-06-01" }),
  file: file("beta-receipt.pdf", "refund processed successfully"),
});
// doc3 — Invoice, Acme, Open, 999, 2026-01-10, no OCR
const doc3 = await documents.createDocument(deps, uploader, {
  folderId: folder.id, documentTypeId: invoice.id,
  fieldValues: vals(invoice, { Name: "Gamma Note", Vendor: "Acme Corp", Status: "Open", Amount: "999", "Due date": "2026-01-10" }),
  file: file("gamma-note.docx"),
});

const S = (params: Parameters<typeof searchDocuments>[2], actor = uploader) => searchDocuments(deps, actor, params);

// ── text search (SRCH-1) ──
check("title match", refs(await S({ departmentId: dept.id, q: "acme" })).includes(doc1.documentRef));
check("field-value match (vendor) finds both Acme docs",
  refs(await S({ departmentId: dept.id, q: "acme" })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));
check("OCR-text match finds the scanned body", refs(await S({ departmentId: dept.id, q: "widgets" })) === doc1.documentRef);
check("filename match", refs(await S({ departmentId: dept.id, q: "gamma" })) === doc3.documentRef);
check("prefix / search-as-you-type ('inv' → invoice filename & type)",
  (await S({ departmentId: dept.id, q: "invoice" })).some((r) => r.documentRef === doc1.documentRef));
check("a no-match query returns nothing", (await S({ departmentId: dept.id, q: "zzzznomatch" })).length === 0);

// ── document-ID search (whole and partial) ──
check("full document-ID search returns just that document", refs(await S({ departmentId: dept.id, q: doc1.documentRef })) === doc1.documentRef);
check("ID-prefix search ('ZZS-INV') returns the invoices",
  refs(await S({ departmentId: dept.id, q: "ZZS-INV" })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));
check("partial-ID (number suffix) search finds the document",
  (await S({ departmentId: dept.id, q: doc1.documentRef.split("-").pop()! })).some((r) => r.documentRef === doc1.documentRef));

// ── document-type scope + filters (SRCH-2) ──
check("document-type filter", refs(await S({ departmentId: dept.id, documentTypeId: invoice.id })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));
check("contains filter (vendor ~ 'acme')",
  refs(await S({ departmentId: dept.id, filters: [{ fieldDefId: F(invoice, "Vendor"), op: "contains", value: "acme" }] })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));
check("dropdown 'in' filter (Status = Open)",
  refs(await S({ departmentId: dept.id, filters: [{ fieldDefId: F(invoice, "Status"), op: "in", values: ["Open"] }] })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));
check("number range (Amount 900–6000 excludes the 250 receipt)",
  refs(await S({ departmentId: dept.id, filters: [{ fieldDefId: F(invoice, "Amount"), op: "number_range", from: "900", to: "6000" }] })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));
check("date range (Due date Feb–Apr 2026 → only doc1)",
  refs(await S({ departmentId: dept.id, filters: [{ fieldDefId: F(invoice, "Due date"), op: "date_range", from: "2026-02-01", to: "2026-04-30" }] })) === doc1.documentRef);
check("filters stack with search (acme + Status Open)",
  refs(await S({ departmentId: dept.id, q: "acme", filters: [{ fieldDefId: F(invoice, "Status"), op: "in", values: ["Open"] }] })) === [doc1, doc3].map((d) => d.documentRef).sort().join(","));

// ── quick views (SRCH-3/4) ──
const recent = await S({ departmentId: dept.id, quickView: "recent" });
check("recent returns all three, most-recent-first", recent.length === 3 && recent[0].documentRef === doc3.documentRef);
check("uploaded-by-me returns the uploader's docs", (await S({ departmentId: dept.id, quickView: "uploaded_by_me" })).length === 3);
check("uploaded-by-me is empty for a different user", (await S({ departmentId: dept.id, quickView: "uploaded_by_me" }, viewer)).length === 0);
check("shared-with-me is an honest empty (Module 9)", (await S({ departmentId: dept.id, quickView: "shared_with_me" })).length === 0);
check("trash is an honest empty (Module 11)", (await S({ departmentId: dept.id, quickView: "trash" })).length === 0);

// ── confidential exclusion (SRCH-5) ──
const vault = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Vault", depth: 0, isConfidential: true },
});
await prisma.confidentialMember.create({ data: { folderId: vault.id, userId: uploaderUser.id, isOwner: true } });
const secret = await documents.createDocument(deps, uploader, {
  folderId: vault.id, documentTypeId: invoice.id,
  fieldValues: vals(invoice, { Name: "Sealed Acme", Vendor: "Acme Corp" }),
  file: file("sealed.pdf", "confidential widgets"),
});
check("a named confidential member finds the sealed document", (await S({ departmentId: dept.id, q: "sealed" }, uploader)).some((r) => r.documentRef === secret.documentRef));
check("a department searcher NOT on the named list never sees it", (await S({ departmentId: dept.id, q: "sealed" }, viewer)).length === 0);
check("nor via a broad query", (await S({ departmentId: dept.id, q: "acme" }, viewer)).every((r) => r.documentRef !== secret.documentRef));
check("Super Admin (excluded from confidential) doesn't see it either", (await S({ departmentId: dept.id, q: "sealed" }, superAdmin)).length === 0);

// ── teardown ──
await prisma.fieldValue.deleteMany({ where: { document: { departmentId: dept.id } } });
await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
await prisma.document.updateMany({ where: { departmentId: dept.id }, data: { currentVersionId: null } });
await prisma.version.deleteMany({ where: { document: { departmentId: dept.id } } });
await prisma.document.deleteMany({ where: { departmentId: dept.id } });
await prisma.documentRefSequence.deleteMany({ where: { departmentId: dept.id } });
await prisma.confidentialMember.deleteMany({ where: { folder: { departmentId: dept.id } } });
await prisma.folder.deleteMany({ where: { departmentId: dept.id } });
await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
await prisma.fieldDef.deleteMany({ where: { documentType: { departmentId: dept.id } } });
await prisma.documentType.deleteMany({ where: { departmentId: dept.id } });
await prisma.role.deleteMany({ where: { departmentId: dept.id } });
await prisma.department.deleteMany({ where: { id: dept.id } });
await prisma.user.deleteMany({ where: { id: viewerUser.id } });

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
