/**
 * Confidential-folder checks — `npm run check:confidential` (backend workspace).
 *
 * Covers Module 10 (CNF-1..4): named-list access, role inheritance disabled, owner un-removable,
 * Super Admin excluded, confidentiality propagation to subfolders, query-layer invisibility, external
 * links forced off, member add/remove, and dual-control recovery of an orphaned vault. DB only, no
 * storage. Point it at a development environment.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import * as folders from "../src/modules/folder/folder.service.js";
import * as conf from "../src/modules/confidential/confidential.service.js";
import { ConfidentialError } from "../src/modules/confidential/confidential.service.js";
import { resolveEffectivePermissions, type PermissionActor } from "../src/lib/effective-permissions.js";
import { permissionMapFrom } from "../src/lib/permissions.js";

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
    const actual = err instanceof ConfidentialError ? err.code : String(err);
    check(label, actual === code, `expected ${code}, got ${actual}`);
  }
}
const canView = async (actor: PermissionActor, dept: string, folderId: string) =>
  (await resolveEffectivePermissions(prisma, actor, dept, folderId)).permissions["documents.view"] === true;

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });

const dept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Conf", idPrefix: "ZZC", subfolderDepthLimit: 5 },
});
const fullRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Full",
    permissions: permissionMapFrom([
      "documents.view", "documents.preview", "documents.download", "documents.version_history",
      "folders.create", "sharing.share", "sharing.external_share", "sharing.create_link",
    ]) as object,
  },
});
const adminRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Dept Admin",
    permissions: permissionMapFrom([
      "documents.view", "members.change_role", "configuration.edit_rules", "folders.create",
    ]) as object,
  },
});

async function user(email: string) {
  return prisma.user.create({ data: { email, passwordHash: "x", fullName: email.split("@")[0], emailVerifiedAt: new Date() } });
}
async function member(userId: string, roleId: string) {
  await prisma.membership.create({ data: { organizationId: org.id, userId, departmentId: dept.id, roleId, status: "active" } });
}

const ownerU = await user("zz-conf-owner@example.test");
await member(ownerU.id, fullRole.id);
const owner: PermissionActor = { userId: ownerU.id, organizationId: org.id, isSuperAdmin: false };

const namedU = await user("zz-conf-named@example.test");
await member(namedU.id, fullRole.id);
const named: PermissionActor = { userId: namedU.id, organizationId: org.id, isSuperAdmin: false };

const roleOnlyU = await user("zz-conf-roleonly@example.test");
await member(roleOnlyU.id, fullRole.id); // same full role, but never named on the vault
const roleOnly: PermissionActor = { userId: roleOnlyU.id, organizationId: org.id, isSuperAdmin: false };

const deptAdminU = await user("zz-conf-deptadmin@example.test");
await member(deptAdminU.id, adminRole.id);
const deptAdmin: PermissionActor = { userId: deptAdminU.id, organizationId: org.id, isSuperAdmin: false };

// A Super Admin actor (org owner). Excluded from confidential access entirely.
const superAdmin: PermissionActor = { userId: org.createdByUserId, organizationId: org.id, isSuperAdmin: true };

try {
  // ── creation (CNF-1) ──
  const vault = await folders.createFolder(deps, owner, dept.id, { name: "Vault", isConfidential: true });
  check("a confidential folder is created", vault.isConfidential === true);
  const ownerRow = await prisma.confidentialMember.findFirst({ where: { folderId: vault.id, userId: ownerU.id } });
  check("the creator is its owner", ownerRow?.isOwner === true);

  // ── named-list access, role inheritance disabled (CNF-1) ──
  check("the owner can view the vault", await canView(owner, dept.id, vault.id));
  check("a role-holder not on the list cannot (inheritance disabled)", !(await canView(roleOnly, dept.id, vault.id)));
  check("the Super Admin is excluded", !(await canView(superAdmin, dept.id, vault.id)));

  // ── external links forced off inside a vault (CNF-3, §11.2) ──
  const ownerPerms = (await resolveEffectivePermissions(prisma, owner, dept.id, vault.id)).permissions;
  check("external links are blocked even for a member with the permission", ownerPerms["sharing.external_share"] !== true);

  // ── propagation to subfolders (CNF-3) ──
  const sub = await folders.createFolder(deps, owner, dept.id, { name: "Inner", parentFolderId: vault.id });
  check("a subfolder is automatically confidential", sub.isConfidential === true);
  const subMembers = await prisma.confidentialMember.count({ where: { folderId: sub.id } });
  check("the subfolder carries no member rows of its own (inherits)", subMembers === 0);
  check("the owner reaches the subfolder via the vault list", await canView(owner, dept.id, sub.id));
  check("a non-member cannot reach the subfolder", !(await canView(roleOnly, dept.id, sub.id)));

  // ── query-layer invisibility (CNF-2) ──
  const roleOnlyTree = await folders.listFolders(deps, roleOnly, dept.id);
  check("the vault is hidden from a non-member's tree", !roleOnlyTree.some((f) => f.id === vault.id));
  check("the subfolder is hidden too", !roleOnlyTree.some((f) => f.id === sub.id));
  const ownerTree = await folders.listFolders(deps, owner, dept.id);
  check("the vault is visible to the owner", ownerTree.some((f) => f.id === vault.id));

  // ── member management (CNF-1) ──
  await conf.addMember(deps, owner, vault.id, namedU.id);
  check("a newly added member gains access", await canView(named, dept.id, vault.id));
  check("management from a subfolder targets the vault root", (await conf.listMembers(deps, owner, sub.id)).members.length === 2);
  await expectError("adding the same person twice is refused", "already_member", () =>
    conf.addMember(deps, owner, vault.id, namedU.id),
  );
  await conf.removeMember(deps, owner, vault.id, namedU.id);
  check("a removed member loses access", !(await canView(named, dept.id, vault.id)));
  await expectError("the owner can't be removed", "cannot_remove_owner", () =>
    conf.removeMember(deps, owner, vault.id, ownerU.id),
  );
  await expectError("a non-member can't list the vault's members", "folder_not_found", () =>
    conf.listMembers(deps, roleOnly, vault.id),
  );
  await expectError("the Super Admin can't manage the vault", "folder_not_found", () =>
    conf.listMembers(deps, superAdmin, vault.id),
  );

  // ── dual-control recovery (CNF-4) ──
  // Orphan the vault: remove every member (simulating the owner's account being gone).
  await prisma.confidentialMember.deleteMany({ where: { folderId: vault.id } });
  const orphaned = await conf.listOrphaned(deps, superAdmin, dept.id);
  check("an orphaned vault is listed for recovery authorities", orphaned.some((f) => f.folderId === vault.id));
  await expectError("an ordinary member can't see the orphan list", "forbidden", () =>
    conf.listOrphaned(deps, roleOnly, dept.id),
  );

  const recovery = await conf.initiateRecovery(deps, superAdmin, vault.id, roleOnlyU.id);
  check("recovery starts with the Super Admin's approval", recovery.superAdminApproved && !recovery.deptAdminApproved);
  await expectError("a second recovery can't be opened while one is pending", "recovery_in_progress", () =>
    conf.initiateRecovery(deps, superAdmin, vault.id, namedU.id),
  );

  // A second Super-Admin approval doesn't complete it — a Department Admin is still required.
  const stillPending = await conf.approveRecovery(deps, superAdmin, recovery.id);
  check("one authority alone can't complete recovery", stillPending.status === "pending");
  check("the nominee has no access yet", !(await canView(roleOnly, dept.id, vault.id)));

  const done = await conf.approveRecovery(deps, deptAdmin, recovery.id);
  check("both authorities together complete recovery", done.status === "completed");
  check("the nominated person is now a member with access", await canView(roleOnly, dept.id, vault.id));
  const restoredOwner = await prisma.confidentialMember.findFirst({ where: { folderId: vault.id, userId: roleOnlyU.id } });
  check("the recovered member is the new owner", restoredOwner?.isOwner === true);
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  await prisma.confidentialRecovery.deleteMany({ where: { folder: { departmentId: dept.id } } });
  await prisma.confidentialMember.deleteMany({ where: { folder: { departmentId: dept.id } } });
  await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
  await prisma.folder.deleteMany({ where: { departmentId: dept.id } });
  await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
  await prisma.role.deleteMany({ where: { departmentId: dept.id } });
  await prisma.department.deleteMany({ where: { id: dept.id } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerU.id, namedU.id, roleOnlyU.id, deptAdminU.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
