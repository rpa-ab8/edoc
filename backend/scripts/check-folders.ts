/**
 * Folder-module checks — `npm run check:folders` (backend workspace).
 *
 * Covers the rules that are cheap to get wrong and expensive to discover later: depth limits at
 * creation *and* on move, cycle prevention, confidentiality flowing down, and the query-layer
 * exclusion that keeps confidential branches invisible.
 *
 * DEV ONLY, and it writes: creates a throwaway department ("ZZ Folder Test") plus folders, then
 * deletes all of it. Point it at a development database, never production.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import * as folders from "../src/modules/folder/folder.service.js";
import { FolderError } from "../src/modules/folder/folder.service.js";
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
    const actual = err instanceof FolderError ? err.code : String(err);
    check(label, actual === code, `expected ${code}, got ${actual}`);
  }
}

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });
const superAdmin: PermissionActor = {
  userId: org.createdByUserId,
  organizationId: org.id,
  isSuperAdmin: true,
};

const dept = await prisma.department.create({
  data: {
    organizationId: org.id,
    name: "ZZ Folder Test",
    idPrefix: "ZZF",
    subjectTerm: "Case",
    identifierTerm: "Case No",
    subfolderDepthLimit: 3,
  },
});
const staffRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Staff",
    permissions: permissionMapFrom(["documents.view", "folders.create"]) as object,
  },
});
const staffUser = await prisma.user.findFirstOrThrow({ where: { email: "ada@example.com" } });
await prisma.membership.create({
  data: { organizationId: org.id, userId: staffUser.id, departmentId: dept.id, roleId: staffRole.id, status: "active" },
});
const staff: PermissionActor = { userId: staffUser.id, organizationId: org.id, isSuperAdmin: false };

// ── creation and depth ──
const root = await folders.createFolder(deps, superAdmin, dept.id, { name: "Contracts" });
check("root folder starts at depth 0", root.depth === 0);
const y2026 = await folders.createFolder(deps, superAdmin, dept.id, { name: "2026", parentFolderId: root.id });
const q1 = await folders.createFolder(deps, superAdmin, dept.id, { name: "Q1", parentFolderId: y2026.id });
const q1a = await folders.createFolder(deps, superAdmin, dept.id, { name: "A", parentFolderId: q1.id });
check("nesting increments depth", q1a.depth === 3);

await expectError("depth limit refuses a fourth level", "depth_limit_reached", () =>
  folders.createFolder(deps, superAdmin, dept.id, { name: "TooDeep", parentFolderId: q1a.id }),
);
await expectError("duplicate name in the same parent refused", "folder_name_taken", () =>
  folders.createFolder(deps, superAdmin, dept.id, { name: "2026", parentFolderId: root.id }),
);
const sameNameElsewhere = await folders.createFolder(deps, superAdmin, dept.id, { name: "2026" });
check("the same name is fine under a different parent", sameNameElsewhere.depth === 0);

// ── lowering the limit must not orphan what exists (FLD-2) ──
await prisma.department.update({ where: { id: dept.id }, data: { subfolderDepthLimit: 1 } });
const afterLowering = await folders.listFolders(deps, superAdmin, dept.id);
check("existing deeper folders survive a lowered limit", afterLowering.some((f) => f.depth === 3));
await expectError("but new folders respect the new limit", "depth_limit_reached", () =>
  folders.createFolder(deps, superAdmin, dept.id, { name: "Nope", parentFolderId: y2026.id }),
);
await prisma.department.update({ where: { id: dept.id }, data: { subfolderDepthLimit: 3 } });

// ── moves ──
await expectError("a folder can't be moved into itself", "invalid_move", () =>
  folders.moveFolder(deps, superAdmin, root.id, root.id),
);
await expectError("a folder can't be moved into its own subfolder", "invalid_move", () =>
  folders.moveFolder(deps, superAdmin, root.id, q1.id),
);
// Moving the whole Contracts branch (3 levels below it) one level down would push its leaves
// past the limit, even though the folder being moved is itself shallow.
await expectError("a move that would breach the depth limit is refused", "depth_limit_reached", () =>
  folders.moveFolder(deps, superAdmin, root.id, sameNameElsewhere.id),
);

const loose = await folders.createFolder(deps, superAdmin, dept.id, { name: "Loose" });
await folders.moveFolder(deps, superAdmin, loose.id, root.id);
const movedRow = await prisma.folder.findUniqueOrThrow({ where: { id: loose.id } });
check("move re-parents and re-depths", movedRow.parentFolderId === root.id && movedRow.depth === 1);

// ── confidentiality flows down, and hides ──
const vault = await folders.createFolder(deps, superAdmin, dept.id, { name: "Vault" });
await prisma.folder.update({ where: { id: vault.id }, data: { isConfidential: true } });
const inVault = await folders.createFolder(deps, superAdmin, dept.id, { name: "Sealed", parentFolderId: vault.id });
check("a child of a confidential folder is confidential at creation", inVault.isConfidential === true);

const staffView = await folders.listFolders(deps, staff, dept.id);
check("a non-member can't see the confidential folder", !staffView.some((f) => f.id === vault.id));
check("nor anything inside it", !staffView.some((f) => f.id === inVault.id));
check("ordinary folders are still visible", staffView.some((f) => f.id === root.id));

const adminView = await folders.listFolders(deps, superAdmin, dept.id);
check("Super Admin is excluded from confidential folders too", !adminView.some((f) => f.id === vault.id));

await prisma.confidentialMember.create({ data: { folderId: vault.id, userId: staffUser.id, isOwner: true } });
const memberView = await folders.listFolders(deps, staff, dept.id);
check("a named member sees the confidential folder", memberView.some((f) => f.id === vault.id));
check("and its contents", memberView.some((f) => f.id === inVault.id));

// ── folder permission overrides (break inheritance, restrict-only) — FLD-3 ──
const analystRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Analyst",
    permissions: permissionMapFrom(["documents.view", "documents.preview", "documents.download"]) as object,
  },
});
const analystUser = await prisma.user.create({
  data: { email: "zz-folder-analyst@example.test", passwordHash: "x", fullName: "ZZ Analyst", emailVerifiedAt: new Date() },
});
await prisma.membership.create({
  data: { organizationId: org.id, userId: analystUser.id, departmentId: dept.id, roleId: analystRole.id, status: "active" },
});
const analyst: PermissionActor = { userId: analystUser.id, organizationId: org.id, isSuperAdmin: false };

const reports = await folders.createFolder(deps, superAdmin, dept.id, { name: "Reports" });
const reportsSub = await folders.createFolder(deps, superAdmin, dept.id, { name: "Sub", parentFolderId: reports.id });

check("analyst inherits download before any override", (await folders.myPermissions(deps, analyst, dept.id, reports.id)).permissions["documents.download"] === true);

await folders.setFolderPermission(deps, superAdmin, reports.id, analystRole.id, ["documents.download"]);
check("an override restricts download on that folder", (await folders.myPermissions(deps, analyst, dept.id, reports.id)).permissions["documents.download"] === false);
check("but view is untouched (restrict-only)", (await folders.myPermissions(deps, analyst, dept.id, reports.id)).permissions["documents.view"] === true);
check("the restriction flows down to subfolders", (await folders.myPermissions(deps, analyst, dept.id, reportsSub.id)).permissions["documents.download"] === false);

const listed = await folders.listFolderPermissions(deps, superAdmin, reports.id);
const analystEntry = listed.roles.find((r) => r.roleId === analystRole.id);
check("the override is reported", analystEntry?.hasOverride === true && analystEntry.restrictedKeys.includes("documents.download"));

await folders.clearFolderPermission(deps, superAdmin, reports.id, analystRole.id);
check("clearing an override restores inheritance", (await folders.myPermissions(deps, analyst, dept.id, reports.id)).permissions["documents.download"] === true);

await expectError("an override can't be set on a confidential folder", "confidential_folder", () =>
  folders.setFolderPermission(deps, superAdmin, vault.id, analystRole.id, ["documents.download"]),
);
await expectError("an override needs a role from this department", "role_not_found", () =>
  folders.setFolderPermission(deps, superAdmin, reports.id, staffRole.id === analystRole.id ? "x" : "00000000-0000-0000-0000-000000000000", ["documents.view"]),
);

// ── deletion guards ──
await expectError("a folder with subfolders can't be deleted", "folder_not_empty", () =>
  folders.deleteFolder(deps, superAdmin, root.id),
);
await folders.deleteFolder(deps, superAdmin, q1a.id);
check("an empty folder deletes", (await prisma.folder.count({ where: { id: q1a.id } })) === 0);

// ── the UI's permission feed ──
const staffPerms = await folders.myPermissions(deps, staff, dept.id);
check("my-permissions reflects the role", staffPerms.permissions["folders.create"] === true);
check("and withholds what the role lacks", staffPerms.permissions["folders.delete"] === false);
const confidentialPerms = await folders.myPermissions(deps, staff, dept.id, vault.id);
check("my-permissions flags a confidential folder", confidentialPerms.isConfidential === true);

// ── teardown ──
await prisma.confidentialMember.deleteMany({ where: { folder: { departmentId: dept.id } } });
await prisma.folderPermission.deleteMany({ where: { folder: { departmentId: dept.id } } });
for (let depth = 5; depth >= 0; depth--) {
  await prisma.folder.deleteMany({ where: { departmentId: dept.id, depth } });
}
await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
await prisma.role.deleteMany({ where: { departmentId: dept.id } });
await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
await prisma.department.delete({ where: { id: dept.id } });
await prisma.user.deleteMany({ where: { email: "zz-folder-analyst@example.test" } });

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
