/**
 * Access-control matrix — `npm run check:access-matrix` (backend workspace).
 *
 * Module 13. The PRD's §4 goal — *"no user can view any document outside their permitted
 * departments and folders"* — is marked "verified by test matrix". This is that matrix.
 *
 * Where `check:tenant-isolation` asserts the boundary **between organizations**, this asserts the
 * boundary **inside one**: department membership, role capability, folder overrides and the
 * confidential named list, each checked against every principal rather than one at a time. The
 * per-module scripts test each mechanism in depth; this crosses them, which is where the gaps that
 * survive per-module testing tend to live.
 *
 * The grid: 6 principals × 4 locations (an ordinary folder, a folder with an override, a
 * confidential vault, and a second department), each asserted for read access and for the specific
 * actions the role does or does not carry.
 *
 * No storage driver is required — documents are created through Module 5's storage-agnostic
 * `createDocument`, and the one purge assertion is a *refusal*, which is decided before any storage
 * call is made.
 *
 * DEV ONLY. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as documents from "../src/modules/document/document.service.js";
import * as folders from "../src/modules/folder/folder.service.js";
import * as search from "../src/modules/search/search.service.js";
import * as sharing from "../src/modules/sharing/sharing.service.js";
import * as audit from "../src/modules/audit/audit.service.js";
import * as confidential from "../src/modules/confidential/confidential.service.js";
import { permissionMapFrom, type PermissionKey } from "../src/lib/permissions.js";
import { resolveEffectivePermissions, type PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma };
const fileDeps = { prisma, env };
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

/** Can this principal open this document at all? The single question the PRD §4 goal asks. */
async function canRead(actor: PermissionActor, documentId: string): Promise<boolean> {
  try {
    await documents.getDocument(deps, actor, documentId);
    return true;
  } catch {
    return false;
  }
}

async function refuses(label: string, run: () => Promise<unknown>, code?: string) {
  try {
    await run();
    check(label, false, "no error thrown");
  } catch (err) {
    const actual = (err as { code?: string }).code ?? String(err);
    if (code) check(label, actual === code, `expected ${code}, got ${actual}`);
    else check(label, true);
  }
}

async function allows(label: string, run: () => Promise<unknown>) {
  try {
    await run();
    check(label, true);
  } catch (err) {
    check(label, false, (err as { code?: string }).code ?? String(err));
  }
}

const stamp = Date.now();

// ─────────────────────────── the fixture ───────────────────────────

const owner = await prisma.user.create({
  data: { email: `zz-acl-owner-${stamp}@example.test`, passwordHash: "x", fullName: "Owner", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ ACL ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5 },
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
      fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, isRequired: true, sortOrder: 0 }] },
    },
    include: { fields: true },
  });
  return { dept, docType };
}

const alpha = await makeDept("Alpha", "ALP");
const beta = await makeDept("Beta", "BET");

function role(departmentId: string, name: string, keys: PermissionKey[]) {
  return prisma.role.create({
    data: { organizationId: org.id, departmentId, name, permissions: permissionMapFrom(keys) as object },
  });
}

// Three role shapes covering the spread the product actually ships: read-only, a working editor,
// and a department administrator.
const viewerRole = await role(alpha.dept.id, "Viewer", ["documents.view", "documents.preview", "search.search"]);
const editorRole = await role(alpha.dept.id, "Editor", [
  "documents.view", "documents.preview", "documents.download", "documents.edit_metadata",
  "documents.upload", "documents.upload_version", "documents.delete", "documents.restore",
  "documents.version_history", "search.search", "sharing.share", "folders.create",
]);
const adminRole = await role(alpha.dept.id, "Dept Admin", [
  "documents.view", "documents.preview", "documents.download", "documents.delete", "documents.restore",
  "members.invite", "members.remove", "members.change_role", "configuration.edit_rules",
  "configuration.create_document_type", "configuration.edit_document_type",
  "audit.view_audit", "audit.export_audit", "search.search",
]);
const betaRole = await role(beta.dept.id, "Beta Staff", ["documents.view", "documents.preview", "search.search"]);

async function makeUser(tag: string, departmentId?: string, roleId?: string) {
  const user = await prisma.user.create({
    data: { email: `zz-acl-${tag}-${stamp}@example.test`, passwordHash: "x", fullName: tag, emailVerifiedAt: new Date() },
  });
  if (departmentId && roleId) {
    await prisma.membership.create({
      data: { organizationId: org.id, userId: user.id, departmentId, roleId, status: "active" },
    });
  }
  return { user, actor: { userId: user.id, organizationId: org.id, isSuperAdmin: false } as PermissionActor };
}

const viewer = await makeUser("viewer", alpha.dept.id, viewerRole.id);
const editor = await makeUser("editor", alpha.dept.id, editorRole.id);
const deptAdmin = await makeUser("admin", alpha.dept.id, adminRole.id);
const betaUser = await makeUser("beta", beta.dept.id, betaRole.id);
// An organization member with no membership in *either* department — the "belongs to the org but
// not to this department" case, which is the one a naive org-only filter would wrongly admit.
const outsider = await makeUser("outsider");
const superAdmin: PermissionActor = { userId: owner.id, organizationId: org.id, isSuperAdmin: true };

// Locations: a plain folder, one carrying a restrict-only override, a confidential vault, and the
// equivalent folder in the other department.
const general = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: alpha.dept.id, name: "General", depth: 0 },
});
const restricted = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: alpha.dept.id, name: "Restricted", depth: 0 },
});
const betaFolder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: beta.dept.id, name: "Beta General", depth: 0 },
});

async function makeDoc(actor: PermissionActor, folderId: string, docType: { id: string; fields: { id: string }[] }, title: string) {
  return documents.createDocument(deps, actor, {
    folderId,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: docType.fields[0].id, value: title }],
    file: {
      storageRef: `zz-acl/${stamp}/${title.replace(/\s+/g, "-")}.pdf`,
      fileName: `${title}.pdf`,
      fileSize: 512,
      mimeType: "application/pdf",
    },
  });
}

const generalDoc = await makeDoc(editor.actor, general.id, alpha.docType, "Alpha General Doc");
const restrictedDoc = await makeDoc(editor.actor, restricted.id, alpha.docType, "Alpha Restricted Doc");
const betaDoc = await makeDoc(betaUser.actor, betaFolder.id, beta.docType, "Beta Doc");

try {
  console.log("\n── baseline: a role grants exactly what it lists, nothing more ──");
  const viewerPerms = (await resolveEffectivePermissions(prisma, viewer.actor, alpha.dept.id)).permissions;
  check("viewer holds documents.view", viewerPerms["documents.view"] === true);
  check("viewer does NOT hold documents.download", viewerPerms["documents.download"] !== true);
  check("viewer does NOT hold documents.delete", viewerPerms["documents.delete"] !== true);
  check("viewer does NOT hold documents.edit_metadata", viewerPerms["documents.edit_metadata"] !== true);
  check("viewer does NOT hold sharing.share", viewerPerms["sharing.share"] !== true);
  check("viewer does NOT hold audit.view_audit", viewerPerms["audit.view_audit"] !== true);

  console.log("\n── the grid: who can read the Alpha/General document ──");
  check("editor (Alpha member)      → yes", (await canRead(editor.actor, generalDoc.id)) === true);
  check("viewer (Alpha member)      → yes", (await canRead(viewer.actor, generalDoc.id)) === true);
  check("dept admin (Alpha member)  → yes", (await canRead(deptAdmin.actor, generalDoc.id)) === true);
  check("beta user (other dept)     → NO", (await canRead(betaUser.actor, generalDoc.id)) === false);
  check("outsider (no membership)   → NO", (await canRead(outsider.actor, generalDoc.id)) === false);
  check(
    "super admin (no membership)→ NO  (narrowed 2026-07-23: administers, cannot read)",
    (await canRead(superAdmin, generalDoc.id)) === false,
  );

  console.log("\n── the grid: who can read the Beta document ──");
  check("beta user   → yes", (await canRead(betaUser.actor, betaDoc.id)) === true);
  check("editor      → NO (membership is per department, not per organization)", (await canRead(editor.actor, betaDoc.id)) === false);
  check("dept admin  → NO (Alpha authority confers nothing in Beta)", (await canRead(deptAdmin.actor, betaDoc.id)) === false);
  check("outsider    → NO", (await canRead(outsider.actor, betaDoc.id)) === false);
  check("super admin → NO", (await canRead(superAdmin, betaDoc.id)) === false);

  console.log("\n── a folder override restricts, and only restricts (FLD-3) ──");
  // Take documents.view away from the Viewer role on the Restricted folder only.
  await folders.setFolderPermission(deps, deptAdmin.actor, restricted.id, viewerRole.id, ["documents.view"]);
  check("viewer can no longer read the restricted folder's document", (await canRead(viewer.actor, restrictedDoc.id)) === false);
  check("viewer can still read the general folder's document (scope is per folder)", (await canRead(viewer.actor, generalDoc.id)) === true);
  check("editor is unaffected — the override targets one role", (await canRead(editor.actor, restrictedDoc.id)) === true);
  await returnsNoRestrictedDoc();

  // The other half of restrict-only: an override that grants everything must not raise a Viewer.
  await folders.setFolderPermission(deps, deptAdmin.actor, restricted.id, viewerRole.id, []);
  const permissive = await prisma.folderPermission.create({
    data: {
      folderId: restricted.id,
      roleId: viewerRole.id,
      permissions: permissionMapFrom([
        "documents.view", "documents.download", "documents.delete", "documents.edit_metadata",
      ]) as object,
    },
  });
  const raised = await resolveEffectivePermissions(prisma, viewer.actor, alpha.dept.id, restricted.id);
  check("a fully-permissive override cannot grant a Viewer download", raised.permissions["documents.download"] !== true);
  check("...nor delete", raised.permissions["documents.delete"] !== true);
  check("...nor edit_metadata", raised.permissions["documents.edit_metadata"] !== true);
  check("...while view, which the role does hold, survives", raised.permissions["documents.view"] === true);
  await prisma.folderPermission.delete({ where: { id: permissive.id } });

  console.log("\n── per-action gating on a document the principal CAN read ──");
  await refuses("viewer can't download", () =>
    documents.getDocumentFile(fileDeps, viewer.actor, generalDoc.id, undefined, "download"),
  );
  await refuses("viewer can't edit metadata", () => documents.editMetadata(deps, viewer.actor, generalDoc.id, []));
  await refuses("viewer can't delete", () => documents.deleteDocument(deps, viewer.actor, generalDoc.id));
  await refuses("viewer can't add a version", () =>
    documents.addVersion(deps, viewer.actor, generalDoc.id, {
      file: { storageRef: "zz-acl/v.pdf", fileName: "v.pdf", fileSize: 1, mimeType: "application/pdf" },
    }),
  );
  await refuses("viewer can't share", () =>
    sharing.createShare(deps, viewer.actor, generalDoc.id, {
      targetType: "user",
      targetUserId: editor.user.id,
      permission: "view",
    }),
  );
  await refuses("viewer can't read the audit trail", () => audit.listAudit(deps, viewer.actor, alpha.dept.id, {}));

  // Folder mutations and search are gated in the route preHandler (`app.requirePermission`), not
  // inside the service — deliberately: the service is the domain layer, and `check:folders` builds
  // its whole fixture as a Super Admin, who holds no `folders.*` key at all. So the assertion has to
  // be made against the same predicate the preHandler consults, which is the resolved permission
  // map. Calling the service directly and expecting a refusal would be testing the wrong layer and
  // would pass only if the gate were duplicated.
  const viewerAtGeneral = (await resolveEffectivePermissions(prisma, viewer.actor, alpha.dept.id, general.id)).permissions;
  check("the route gate would refuse a viewer folders.create", viewerAtGeneral["folders.create"] !== true);
  check("...folders.rename", viewerAtGeneral["folders.rename"] !== true);
  check("...folders.delete", viewerAtGeneral["folders.delete"] !== true);
  check("...folders.move", viewerAtGeneral["folders.move"] !== true);
  check("...documents.upload", viewerAtGeneral["documents.upload"] !== true);
  await allows("editor CAN edit metadata (the control for the refusals above)", () =>
    documents.editMetadata(deps, editor.actor, generalDoc.id, [
      { fieldDefId: alpha.docType.fields[0].id, value: "Alpha General Doc" },
    ]),
  );

  console.log("\n── audit: view and export are separate grants (AUD-4) ──");
  await allows("dept admin can read the audit trail", () => audit.listAudit(deps, deptAdmin.actor, alpha.dept.id, {}));
  await allows("dept admin can export it", () => audit.exportAudit(deps, deptAdmin.actor, alpha.dept.id, {}));
  const viewOnlyAuditor = await makeUser("auditor", alpha.dept.id, (await role(alpha.dept.id, "Auditor", ["audit.view_audit"])).id);
  await allows("a view-only auditor can read", () => audit.listAudit(deps, viewOnlyAuditor.actor, alpha.dept.id, {}));
  await refuses("...but cannot export", () => audit.exportAudit(deps, viewOnlyAuditor.actor, alpha.dept.id, {}));

  console.log("\n── confidential vault: the named list is the only door (CNF-1..3) ──");
  const vault = await folders.createFolder(deps, editor.actor, alpha.dept.id, {
    name: "Vault",
    parentFolderId: null,
    isConfidential: true,
    memberUserIds: [],
  });
  const vaultSub = await folders.createFolder(deps, editor.actor, alpha.dept.id, {
    name: "Vault Sub",
    parentFolderId: vault.id,
  });
  const vaultDoc = await makeDoc(editor.actor, vault.id, alpha.docType, "Vault Doc");
  const vaultSubDoc = await makeDoc(editor.actor, vaultSub.id, alpha.docType, "Vault Sub Doc");

  check("the creator (a named owner) can read the vault document", (await canRead(editor.actor, vaultDoc.id)) === true);
  check("confidentiality propagates: they can read the subfolder's document too", (await canRead(editor.actor, vaultSubDoc.id)) === true);
  check("a Viewer in the same department cannot — role inheritance is disabled", (await canRead(viewer.actor, vaultDoc.id)) === false);
  check("the DEPT ADMIN cannot — administrative authority is not vault access", (await canRead(deptAdmin.actor, vaultDoc.id)) === false);
  check("the SUPER ADMIN cannot — the one boundary they never cross (§11.2)", (await canRead(superAdmin, vaultDoc.id)) === false);
  check("...nor into the inherited subfolder", (await canRead(superAdmin, vaultSubDoc.id)) === false);

  const vaultTree = await folders.listFolders(deps, deptAdmin.actor, alpha.dept.id);
  check("the vault is absent from a non-member's folder tree", vaultTree.every((f) => f.id !== vault.id));
  check("...and so is its subfolder (no leaking the parent's existence)", vaultTree.every((f) => f.id !== vaultSub.id));
  const superTree = await folders.listFolders(deps, superAdmin, alpha.dept.id);
  check("the vault is absent from the super admin's folder tree too", superTree.every((f) => f.id !== vault.id));

  const adminSearch = await search.searchDocuments(deps, deptAdmin.actor, { departmentId: alpha.dept.id, q: "Vault" });
  check("a non-member's search never returns vault documents (SRCH-5)", adminSearch.every((r) => r.id !== vaultDoc.id));
  const memberSearch = await search.searchDocuments(deps, editor.actor, { departmentId: alpha.dept.id, q: "Vault" });
  check("(control) a vault member's search does find them", memberSearch.some((r) => r.id === vaultDoc.id));

  await refuses(
    "a non-member can't look the vault document up by its ID",
    () => documents.lookupByRef(deps, deptAdmin.actor, vaultDoc.documentRef),
    "document_not_found",
  );
  await refuses(
    "a non-member can't read the vault's named list",
    () => confidential.listMembers(deps, deptAdmin.actor, vault.id),
    "folder_not_found",
  );
  await refuses(
    "a non-member can't add themselves to the vault",
    () => confidential.addMember(deps, deptAdmin.actor, vault.id, deptAdmin.user.id),
    "folder_not_found",
  );
  const vaultPerms = await resolveEffectivePermissions(prisma, editor.actor, alpha.dept.id, vault.id);
  check("external sharing is forced off inside a vault (external_share)", vaultPerms.permissions["sharing.external_share"] !== true);
  check("...and create_link", vaultPerms.permissions["sharing.create_link"] !== true);
  await refuses("a vault document can't leave by external link", () =>
    sharing.createShare(deps, editor.actor, vaultDoc.id, { targetType: "external_link", permission: "view", expiresInDays: 7 }),
  );

  console.log("\n── destroying what you cannot see (Module 13 finding) ──");
  await documents.deleteDocument(deps, editor.actor, vaultDoc.id);
  const adminTrash = await documents.listTrash(deps, deptAdmin.actor, alpha.dept.id);
  check("the trashed vault document is invisible in a non-member's trash", adminTrash.every((t) => t.id !== vaultDoc.id));
  await refuses(
    "a Dept Admin cannot PURGE a vault document by ID",
    () => documents.purgeDocument(fileDeps, deptAdmin.actor, vaultDoc.id),
    "document_not_found",
  );
  const emptied = await documents.emptyTrash(fileDeps, deptAdmin.actor, alpha.dept.id);
  check("'Empty trash' destroys nothing a non-member couldn't see", emptied.purged === 0, `purged ${emptied.purged}`);
  check("the vault document is still in the trash afterwards", (await documents.listTrash(deps, editor.actor, alpha.dept.id)).some((t) => t.id === vaultDoc.id));

  console.log("\n── membership status is enforced, not just membership existence ──");
  await prisma.membership.updateMany({
    where: { userId: viewer.user.id, departmentId: alpha.dept.id },
    data: { status: "disabled" },
  });
  check("a disabled member loses access immediately", (await canRead(viewer.actor, generalDoc.id)) === false);
  // Same layering point as folders: `searchDocuments` is reached only through a route that resolves
  // `search.search` first. A disabled membership resolves to *nothing* — the engine's membership
  // lookup filters `status: "active"` — so the gate closes before the query runs. Asserting the
  // resolution is asserting the enforcement.
  const disabledPerms = (await resolveEffectivePermissions(prisma, viewer.actor, alpha.dept.id)).permissions;
  check("a disabled member resolves no search.search — the route gate closes", disabledPerms["search.search"] !== true);
  check("...and no documents.view", disabledPerms["documents.view"] !== true);
  await prisma.membership.updateMany({
    where: { userId: viewer.user.id, departmentId: alpha.dept.id },
    data: { status: "active" },
  });
  check("re-enabling restores it", (await canRead(viewer.actor, generalDoc.id)) === true);

  console.log("\n── a share grants a read-only floor, never the sharer's full hand (SHR) ──");
  // The recipient is the *Beta* user: a real organization member with no standing access to Alpha.
  // (A user with no membership anywhere isn't a valid share target at all — `resolveOrgUser` refuses
  // them, which is correct: sharing reaches colleagues, not arbitrary accounts.)
  await refuses("a user with no membership anywhere isn't even a valid share target", () =>
    sharing.createShare(deps, editor.actor, generalDoc.id, {
      targetType: "user",
      targetUserId: outsider.user.id,
      permission: "view",
    }),
  );
  check("(precondition) the Beta user cannot read the Alpha document", (await canRead(betaUser.actor, generalDoc.id)) === false);
  const share = await sharing.createShare(deps, editor.actor, generalDoc.id, {
    targetType: "user",
    targetUserId: betaUser.user.id,
    permission: "view",
  });
  check("the recipient can now read exactly the shared document", (await canRead(betaUser.actor, generalDoc.id)) === true);
  await refuses("...but still cannot download it (view-only share)", () =>
    documents.getDocumentFile(fileDeps, betaUser.actor, generalDoc.id, undefined, "download"),
  );
  await refuses("...cannot edit it", () => documents.editMetadata(deps, betaUser.actor, generalDoc.id, []));
  await refuses("...cannot delete it", () => documents.deleteDocument(deps, betaUser.actor, generalDoc.id));
  await refuses("...cannot re-share it", () =>
    sharing.createShare(deps, betaUser.actor, generalDoc.id, {
      targetType: "user",
      targetUserId: viewer.user.id,
      permission: "view",
    }),
  );
  const sharedPerms = (await resolveEffectivePermissions(prisma, betaUser.actor, alpha.dept.id)).permissions;
  check("a share confers no standing role in the source department", sharedPerms["search.search"] !== true);
  check("...so the route gate still keeps them out of Alpha's search", sharedPerms["documents.view"] !== true);
  check(
    "...and the share reaches one document, not the folder around it",
    (await canRead(betaUser.actor, restrictedDoc.id)) === false,
  );
  await sharing.revokeShare(deps, editor.actor, share.share.id);
  check("revoking is immediate", (await canRead(betaUser.actor, generalDoc.id)) === false);

  // ── helpers used above (declared here so the narrative above reads top-to-bottom) ──
  async function returnsNoRestrictedDoc() {
    const results = await search.searchDocuments(deps, viewer.actor, { departmentId: alpha.dept.id, q: "Restricted" });
    check("a folder override also removes the document from search", results.every((r) => r.id !== restrictedDoc.id));
  }
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  await prisma.auditEvent.deleteMany({ where: { organizationId: org.id } });
  await prisma.confidentialRecovery.deleteMany({ where: { organizationId: org.id } });
  await prisma.confidentialMember.deleteMany({ where: { folder: { organizationId: org.id } } });
  await prisma.folderPermission.deleteMany({ where: { folder: { organizationId: org.id } } });
  await prisma.share.deleteMany({ where: { organizationId: org.id } });
  await prisma.fieldValue.deleteMany({ where: { document: { organizationId: org.id } } });
  await prisma.document.updateMany({ where: { organizationId: org.id }, data: { currentVersionId: null } });
  await prisma.version.deleteMany({ where: { organizationId: org.id } });
  await prisma.document.deleteMany({ where: { organizationId: org.id } });
  await prisma.documentRefSequence.deleteMany({ where: { organizationId: org.id } });
  await prisma.folder.deleteMany({ where: { organizationId: org.id } });
  await prisma.membership.deleteMany({ where: { organizationId: org.id } });
  await prisma.fieldDef.deleteMany({ where: { documentType: { department: { organizationId: org.id } } } });
  await prisma.documentType.deleteMany({ where: { department: { organizationId: org.id } } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.storageConfig.deleteMany({ where: { organizationId: org.id } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `zz-acl-` } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
