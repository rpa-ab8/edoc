/**
 * Tenant-isolation matrix — `npm run check:tenant-isolation` (backend workspace).
 *
 * Module 13. The PRD's NFR table states tenant isolation is "verified by test"; this is that test.
 * CLAUDE.md's first hard rule: *every table except `user` carries `organization_id`, every query
 * filters on it, no exceptions.* A bug here is the most expensive class of bug this system can have
 * — one organization reading another's documents — so this asserts the boundary from the outside,
 * at the service entry points a real request reaches, rather than trusting the query text.
 *
 * Two complete organizations are built from scratch (never the real "Abate" org), each with its own
 * department, roles, folders, document types and documents. Then every reachable service is called
 * with **org B's actor and org A's ids** and must refuse. Refusal must look like absence
 * (`not_found`) wherever the resource's existence is itself confidential.
 *
 * No storage driver is needed: documents are created through Module 5's storage-agnostic
 * `createDocument` with a stand-in `storageRef`, exactly as Module 5's own checks do.
 *
 * DEV ONLY. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import * as documents from "../src/modules/document/document.service.js";
import * as folders from "../src/modules/folder/folder.service.js";
import * as departments from "../src/modules/department/department.service.js";
import * as search from "../src/modules/search/search.service.js";
import * as sharing from "../src/modules/sharing/sharing.service.js";
import * as audit from "../src/modules/audit/audit.service.js";
import * as confidential from "../src/modules/confidential/confidential.service.js";
import { permissionMapFrom, ALL_PERMISSION_KEYS } from "../src/lib/permissions.js";
import {
  resolveEffectivePermissions,
  confidentialFolderIdsToExclude,
  type PermissionActor,
} from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const deps = { prisma };
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

/** Asserts a call is refused. Any thrown error counts as a refusal; when `code` is given the
 *  refusal must be that specific one (used where "not found" vs "forbidden" is itself the rule). */
async function refuses(label: string, run: () => Promise<unknown>, code?: string) {
  try {
    const result = await run();
    check(label, false, `no error thrown, returned ${JSON.stringify(result)?.slice(0, 120)}`);
  } catch (err) {
    const actual = (err as { code?: string }).code ?? String(err);
    if (code) check(label, actual === code, `expected ${code}, got ${actual}`);
    else check(label, true);
  }
}

/** Asserts a listing call succeeds but returns nothing belonging to the other tenant. */
async function returnsEmpty(label: string, run: () => Promise<unknown[]>) {
  try {
    const rows = await run();
    check(label, rows.length === 0, `leaked ${rows.length} row(s)`);
  } catch {
    // A refusal is an equally acceptable outcome for a listing — it leaks nothing either.
    check(label, true);
  }
}

const stamp = Date.now();
const ALL = permissionMapFrom([...ALL_PERMISSION_KEYS]) as object;

/** Builds a complete, self-contained organization: owner (Super Admin), a department with a role
 *  holding every permission, a member, a root folder, a document type and one document. */
async function buildOrg(tag: string) {
  const owner = await prisma.user.create({
    data: {
      email: `zz-iso-${tag}-owner-${stamp}@example.test`,
      passwordHash: "x",
      fullName: `Owner ${tag}`,
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: { name: `ZZ Iso ${tag} ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
  });
  const dept = await prisma.department.create({
    data: { organizationId: org.id, name: `Dept ${tag}`, idPrefix: `Z${tag}`, subfolderDepthLimit: 5 },
  });
  const role = await prisma.role.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "Everything", permissions: ALL },
  });
  const member = await prisma.user.create({
    data: {
      email: `zz-iso-${tag}-member-${stamp}@example.test`,
      passwordHash: "x",
      fullName: `Member ${tag}`,
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.create({
    data: { organizationId: org.id, userId: member.id, departmentId: dept.id, roleId: role.id, status: "active" },
  });
  const docType = await prisma.documentType.create({
    data: {
      departmentId: dept.id,
      name: "Note",
      idCode: "NTE",
      fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, isRequired: true, sortOrder: 0 }] },
    },
    include: { fields: true },
  });
  const folder = await prisma.folder.create({
    data: { organizationId: org.id, departmentId: dept.id, name: "General", depth: 0 },
  });

  const actor: PermissionActor = { userId: member.id, organizationId: org.id, isSuperAdmin: false };
  const superAdmin: PermissionActor = { userId: owner.id, organizationId: org.id, isSuperAdmin: true };

  const doc = await documents.createDocument(deps, actor, {
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: docType.fields[0].id, value: `Secret of ${tag}` }],
    file: {
      storageRef: `zz-iso/${tag}/${stamp}.pdf`,
      fileName: `${tag}.pdf`,
      fileSize: 1024,
      mimeType: "application/pdf",
      checksum: `zzchecksum-${tag}-${stamp}`,
    },
  });

  return { owner, org, dept, role, member, docType, folder, actor, superAdmin, doc };
}

const A = await buildOrg("A");
const B = await buildOrg("B");

try {
  console.log("\n── the setup itself is sound (each tenant can reach its own data) ──");
  check("org A's member can open org A's document", Boolean(await documents.getDocument(deps, A.actor, A.doc.id)));
  check("org B's member can open org B's document", Boolean(await documents.getDocument(deps, B.actor, B.doc.id)));
  check(
    "org A's member resolves real permissions in org A",
    (await resolveEffectivePermissions(prisma, A.actor, A.dept.id)).permissions["documents.view"] === true,
  );

  console.log("\n── the permission engine refuses across the tenant boundary ──");
  const crossResolved = await resolveEffectivePermissions(prisma, B.actor, A.dept.id);
  check("org B's actor resolves NO permissions in org A's department", crossResolved.source === "none");
  check(
    "and every key is false, not merely the one we asked about",
    ALL_PERMISSION_KEYS.every((k) => crossResolved.permissions[k] !== true),
  );
  const crossFolder = await resolveEffectivePermissions(prisma, B.actor, A.dept.id, A.folder.id);
  check("resolving org A's folder for org B's actor grants nothing", crossFolder.source === "none");
  const crossSuper = await resolveEffectivePermissions(prisma, B.superAdmin, A.dept.id);
  check(
    "org B's SUPER ADMIN resolves nothing in org A (ownership is not global)",
    crossSuper.source === "none" && ALL_PERMISSION_KEYS.every((k) => crossSuper.permissions[k] !== true),
  );

  console.log("\n── documents ──");
  await refuses("org B can't open org A's document", () => documents.getDocument(deps, B.actor, A.doc.id), "document_not_found");
  await refuses(
    "org B's super admin can't open org A's document",
    () => documents.getDocument(deps, B.superAdmin, A.doc.id),
    "document_not_found",
  );
  await refuses(
    "org B can't read org A's document activity",
    () => documents.getDocumentActivity(deps, B.actor, A.doc.id),
    "document_not_found",
  );
  await refuses(
    "org B can't edit org A's document metadata",
    () => documents.editMetadata(deps, B.actor, A.doc.id, []),
    "document_not_found",
  );
  await refuses(
    "org B can't delete org A's document",
    () => documents.deleteDocument(deps, B.actor, A.doc.id),
    "document_not_found",
  );
  await refuses(
    "org B can't restore org A's document",
    () => documents.restoreDocument(deps, B.actor, A.doc.id),
    "document_not_found",
  );
  await refuses(
    "org B can't add a version to org A's document",
    () =>
      documents.addVersion(deps, B.actor, A.doc.id, {
        file: {
          storageRef: "zz-iso/hostile.pdf",
          fileName: "hostile.pdf",
          fileSize: 1,
          mimeType: "application/pdf",
        },
      }),
    "document_not_found",
  );
  await refuses(
    "org B can't file a document into org A's folder",
    () =>
      documents.createDocument(deps, B.actor, {
        folderId: A.folder.id,
        documentTypeId: B.docType.id,
        fieldValues: [{ fieldDefId: B.docType.fields[0].id, value: "trespass" }],
        file: { storageRef: "zz-iso/x.pdf", fileName: "x.pdf", fileSize: 1, mimeType: "application/pdf" },
      }),
    "folder_not_found",
  );
  await refuses(
    "org B can't attach org A's document type to its own folder",
    () =>
      documents.createDocument(deps, B.actor, {
        folderId: B.folder.id,
        documentTypeId: A.docType.id,
        fieldValues: [],
        file: { storageRef: "zz-iso/y.pdf", fileName: "y.pdf", fileSize: 1, mimeType: "application/pdf" },
      }),
    "document_type_mismatch",
  );
  await refuses(
    "org B can't list documents in org A's folder",
    () => documents.listFolderDocuments(deps, B.actor, A.folder.id),
    "folder_not_found",
  );
  await refuses(
    "org B can't look up org A's document by its ID (DOC-3 path)",
    () => documents.lookupByRef(deps, B.actor, A.doc.documentRef),
    "document_not_found",
  );
  await returnsEmpty("org B's needs-details queue can't reach org A's department", () =>
    documents.listNeedsDetails(deps, B.actor, A.dept.id),
  );
  await returnsEmpty("org B's trash view can't reach org A's department", () =>
    documents.listTrash(deps, B.actor, A.dept.id),
  );
  await returnsEmpty("duplicate detection can't match across tenants", () =>
    documents.findDuplicatesInDepartment(deps, B.actor, A.dept.id, `zzchecksum-A-${stamp}`),
  );
  await refuses("org B can't empty org A's trash", () =>
    documents.emptyTrash({ prisma, env: {} as never }, B.actor, A.dept.id),
  );

  console.log("\n── folders ──");
  await refuses("org B can't list org A's folder tree", () => folders.listFolders(deps, B.actor, A.dept.id), "department_not_found");
  await refuses("org B can't read org A's folder path", () => folders.folderPath(deps, B.actor, A.folder.id), "folder_not_found");
  await refuses(
    "org B can't create a subfolder under org A's folder",
    () => folders.createFolder(deps, B.actor, A.dept.id, { name: "trespass", parentFolderId: A.folder.id }),
    "department_not_found",
  );
  await refuses("org B can't rename org A's folder", () => folders.renameFolder(deps, B.actor, A.folder.id, "pwned"), "folder_not_found");
  await refuses("org B can't move org A's folder", () => folders.moveFolder(deps, B.actor, A.folder.id, null), "folder_not_found");
  await refuses("org B can't delete org A's folder", () => folders.deleteFolder(deps, B.actor, A.folder.id), "folder_not_found");
  await refuses(
    "org B can't read org A's folder permission overrides",
    () => folders.listFolderPermissions(deps, B.actor, A.folder.id),
    "folder_not_found",
  );
  await refuses(
    "org B can't set an override on org A's folder",
    () => folders.setFolderPermission(deps, B.actor, A.folder.id, A.role.id, []),
    "folder_not_found",
  );
  await refuses(
    "org B can't move its own folder under org A's folder",
    () => folders.moveFolder(deps, B.actor, B.folder.id, A.folder.id),
    "parent_not_found",
  );

  console.log("\n── departments, roles, members ──");
  const visible = await departments.listDepartments(deps, {
    userId: B.actor.userId,
    organizationId: B.org.id,
    isSuperAdmin: false,
  });
  check(
    "org B's department list contains only org B's departments",
    visible.every((d) => d.id !== A.dept.id) && visible.some((d) => d.id === B.dept.id),
  );
  const bSuperList = await departments.listDepartments(deps, {
    userId: B.superAdmin.userId,
    organizationId: B.org.id,
    isSuperAdmin: true,
  });
  check("org B's super admin sees org B's departments only", bSuperList.every((d) => d.id !== A.dept.id));
  await refuses("org B can't read org A's department detail", () =>
    departments.getDepartment(deps, { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false }, A.dept.id),
  );
  await refuses("org B can't create a role in org A's department", () =>
    departments.createRole(deps, { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false }, A.dept.id, {
      name: "trespass",
      permissions: {},
    }),
  );
  await refuses("org B can't change a role in org A's department", () =>
    departments.updateRole(deps, { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false }, A.dept.id, A.role.id, {
      name: "pwned",
      permissions: ALL as never,
    }),
  );
  await refuses("org B can't add itself to org A's department", () =>
    departments.addMember(
      deps,
      { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false },
      A.dept.id,
      B.member.id,
      A.role.id,
    ),
  );
  await refuses("org B can't remove a member from org A's department", () =>
    departments.removeMember(deps, { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false }, A.dept.id, A.member.id),
  );
  await refuses("org B can't create a document type in org A's department", () =>
    departments.createDocumentType(deps, { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false }, A.dept.id, {
      name: "trespass",
      idCode: "TRS",
      fields: [{ label: "T", fieldType: "text", isTitle: true, isRequired: true, isFilterable: false }],
    }),
  );
  await refuses("org B can't delete org A's document type", () =>
    departments.deleteDocumentType(
      deps,
      { userId: B.actor.userId, organizationId: B.org.id, isSuperAdmin: false },
      A.dept.id,
      A.docType.id,
    ),
  );

  console.log("\n── search ──");
  await returnsEmpty("org B's search can't reach org A's department", () =>
    search.searchDocuments(deps, B.actor, { departmentId: A.dept.id }),
  );
  const bSearch = await search.searchDocuments(deps, B.actor, { departmentId: B.dept.id, q: "Secret" });
  check(
    "searching org B for a term only org A's document holds returns nothing of org A's",
    bSearch.every((r) => r.id !== A.doc.id),
  );
  const aSearch = await search.searchDocuments(deps, A.actor, { departmentId: A.dept.id, q: "Secret" });
  check("(control) the same search inside org A does find it", aSearch.some((r) => r.id === A.doc.id));
  await returnsEmpty("org B can't search org A by pasting its document ID", () =>
    search.searchDocuments(deps, B.actor, { departmentId: A.dept.id, q: A.doc.documentRef }),
  );

  console.log("\n── sharing ──");
  await refuses(
    "org B can't share org A's document",
    () => sharing.createShare(deps, B.actor, A.doc.id, { targetType: "user", targetUserId: B.member.id, permission: "view" }),
    "document_not_found",
  );
  await refuses(
    "org B can't list the shares on org A's document",
    () => sharing.listDocumentShares(deps, B.actor, A.doc.id),
    "document_not_found",
  );
  // A share created legitimately inside org A must stay invisible and untouchable from org B.
  const aShare = await sharing.createShare(deps, A.actor, A.doc.id, {
    targetType: "user",
    targetUserId: A.owner.id,
    permission: "view",
  });
  await returnsEmpty("org A's share never appears in org B's inbox", async () =>
    (await sharing.listSharedWithMe(deps, B.actor)).filter((s) => s.id === aShare.share.id),
  );
  await returnsEmpty("org A's share never appears in org B's sent list", async () =>
    (await sharing.listSharedByMe(deps, B.actor)).filter((s) => s.id === aShare.share.id),
  );
  await refuses("org B can't revoke org A's share", () => sharing.revokeShare(deps, B.actor, aShare.share.id), "share_not_found");
  await refuses("org B can't re-permission org A's share", () =>
    sharing.updateShare(deps, B.actor, aShare.share.id, { permission: "download" }),
  );
  await refuses("org B can't dismiss org A's share", () => sharing.dismissShare(deps, B.actor, aShare.share.id), "share_not_found");
  await refuses("org B can't read org A's pending cross-department shares", () =>
    sharing.listPendingForDepartment(deps, B.actor, A.dept.id),
  );
  await refuses("org B can't share a document to a department in org A", () =>
    sharing.createShare(deps, B.actor, B.doc.id, {
      targetType: "department",
      targetDepartmentId: A.dept.id,
      permission: "view",
    }),
  );
  await refuses("org B can't share a document to a user in org A", () =>
    sharing.createShare(deps, B.actor, B.doc.id, {
      targetType: "user",
      targetUserId: A.member.id,
      permission: "view",
    }),
  );

  console.log("\n── audit ──");
  await returnsEmpty("org B can't read org A's audit trail", async () =>
    (await audit.listAudit(deps, B.actor, A.dept.id, {})).events,
  );
  await refuses("org B can't export org A's audit trail", () => audit.exportAudit(deps, B.actor, A.dept.id, {}));
  const bAudit = await audit.listAudit(deps, B.actor, B.dept.id, {});
  check(
    "org B's own audit trail carries no org A events",
    bAudit.events.every((e) => !e.targetDescription?.includes(A.doc.documentRef)),
  );

  console.log("\n── confidential vaults ──");
  const aVault = await folders.createFolder(deps, A.actor, A.dept.id, {
    name: "Vault A",
    parentFolderId: null,
    isConfidential: true,
    memberUserIds: [],
  });
  await refuses(
    "org B can't list org A's vault members",
    () => confidential.listMembers(deps, B.actor, aVault.id),
    "folder_not_found",
  );
  await refuses(
    "org B can't add itself to org A's vault",
    () => confidential.addMember(deps, B.actor, aVault.id, B.member.id),
    "folder_not_found",
  );
  await refuses(
    "org B can't remove a member from org A's vault",
    () => confidential.removeMember(deps, B.actor, aVault.id, A.member.id),
    "folder_not_found",
  );
  await refuses("org B can't enumerate orphaned vaults in org A", () =>
    confidential.listOrphaned(deps, B.superAdmin, A.dept.id),
  );
  await refuses(
    "org B can't initiate a recovery of org A's vault",
    () => confidential.initiateRecovery(deps, B.superAdmin, aVault.id, B.member.id),
    "folder_not_found",
  );
  const bExcluded = await confidentialFolderIdsToExclude(prisma, B.actor, undefined);
  check("org B's confidential-exclusion set never mentions org A's vault", !bExcluded.includes(aVault.id));

  console.log("\n── the storage boundary ──");
  const aConfig = await prisma.storageConfig.findFirst({ where: { organizationId: A.org.id } });
  check(
    "a new organization has no storage config to inherit from another tenant",
    aConfig === null,
    "org A unexpectedly has a storage config",
  );
  const refs = await prisma.version.findMany({
    where: { organizationId: B.org.id },
    select: { storageRef: true },
  });
  check(
    "org B's storage refs are all its own (no ref points into org A's space)",
    refs.every((r) => !r.storageRef.includes("/A/")),
  );

  console.log("\n── row-count sanity: nothing crossed over ──");
  const [aDocs, bDocs] = await Promise.all([
    prisma.document.count({ where: { organizationId: A.org.id } }),
    prisma.document.count({ where: { organizationId: B.org.id } }),
  ]);
  check("each organization still holds exactly its own document", aDocs === 1 && bDocs === 1, `A=${aDocs} B=${bDocs}`);
  // `document` has no `department` relation (only the scalar FK), so the cross-check walks folders:
  // a document's folder must live in the same organization as the document itself.
  const strays = await prisma.document.count({
    where: { organizationId: A.org.id, folder: { organizationId: { not: A.org.id } } },
  });
  check("no document in org A hangs off a folder in another organization", strays === 0);

  const strayFolders = await prisma.folder.count({
    where: { organizationId: A.org.id, department: { organizationId: { not: A.org.id } } },
  });
  check("no folder in org A hangs off a department in another organization", strayFolders === 0);

  const strayVersions = await prisma.version.count({
    where: { organizationId: A.org.id, document: { organizationId: { not: A.org.id } } },
  });
  check("no version in org A hangs off a document in another organization", strayVersions === 0);
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  for (const O of [A, B]) {
    await prisma.auditEvent.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.confidentialRecovery.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.confidentialMember.deleteMany({ where: { folder: { organizationId: O.org.id } } });
    await prisma.folderPermission.deleteMany({ where: { folder: { organizationId: O.org.id } } });
    await prisma.share.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.fieldValue.deleteMany({ where: { document: { organizationId: O.org.id } } });
    await prisma.document.updateMany({ where: { organizationId: O.org.id }, data: { currentVersionId: null } });
    await prisma.version.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.document.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.documentRefSequence.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.folder.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.membership.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.fieldDef.deleteMany({ where: { documentType: { departmentId: O.dept.id } } });
    await prisma.documentType.deleteMany({ where: { departmentId: O.dept.id } });
    await prisma.role.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.invitation.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.storageConfig.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.department.deleteMany({ where: { organizationId: O.org.id } });
    await prisma.organization.deleteMany({ where: { id: O.org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [O.owner.id, O.member.id] } } });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
