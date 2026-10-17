/**
 * Effective-permission engine checks — `npm run check:permissions` (backend workspace).
 *
 * The resolution order this asserts is a CLAUDE.md hard rule, and every protected resource
 * downstream inherits its correctness, so these run against a real database rather than mocks.
 *
 * DEV ONLY, and it writes: it creates a throwaway department ("ZZ Engine Test") with folders,
 * overrides and confidential members, then deletes all of it. Point it at a development database,
 * never production. If it exits early the fixture may survive — the department name is the handle
 * to clean up by.
 *
 * There is no test runner in this project yet; when one is chosen, port these cases to it rather
 * than rewriting them.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });
import {
  resolveEffectivePermissions,
  confidentialFolderIdsToExclude,
} from "../src/lib/effective-permissions.js";
import { permissionMapFrom, ALL_PERMISSION_KEYS } from "../src/lib/permissions.js";

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`}`);
  if (ok) pass++;
  else fail++;
}

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });
const superAdminId = org.createdByUserId;
const staffUser = await prisma.user.findFirstOrThrow({ where: { email: "ada@example.com" } });
const outsider = await prisma.user.findFirstOrThrow({ where: { email: { not: staffUser.email }, id: { not: superAdminId } } });

// ── throwaway fixture ──
const dept = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Engine Test", idPrefix: "ZZT", subjectTerm: "Case", identifierTerm: "Case No" },
});
const staffRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Staff",
    permissions: permissionMapFrom([
      "documents.view",
      "documents.upload",
      "documents.download",
      "documents.preview",
      "sharing.share",
      "sharing.create_link",
      "search.search",
    ]) as object,
  },
});
await prisma.membership.create({
  data: { organizationId: org.id, userId: staffUser.id, departmentId: dept.id, roleId: staffRole.id, status: "active" },
});

const root = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Root", depth: 0 },
});
const child = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Child", parentFolderId: root.id, depth: 1 },
});
const grandchild = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Grandchild", parentFolderId: child.id, depth: 2 },
});
const confidential = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Confidential", parentFolderId: root.id, depth: 1, isConfidential: true },
});
const underConfidential = await prisma.folder.create({
  // NOTE: isConfidential deliberately left false to prove inheritance is resolved by walking the
  // chain, not by trusting the child's own flag.
  data: { organizationId: org.id, departmentId: dept.id, name: "Sub of confidential", parentFolderId: confidential.id, depth: 2 },
});

const staff = { userId: staffUser.id, organizationId: org.id, isSuperAdmin: false };
const admin = { userId: superAdminId, organizationId: org.id, isSuperAdmin: true };
const stranger = { userId: outsider.id, organizationId: org.id, isSuperAdmin: false };

const granted = async (actor: typeof staff, folderId?: string | null) => {
  const r = await resolveEffectivePermissions(prisma, actor, dept.id, folderId);
  return { on: ALL_PERMISSION_KEYS.filter((k) => r.permissions[k]), source: r.source, confidential: r.isConfidential };
};

// 1. Super Admin with no membership: administers the department, cannot read it.
// (User decision 2026-07-23, overriding Feature Spec §2A.1 — see the engine's comment.)
const superAll = await granted(admin);
check("super admin without a membership gets administrative keys only", superAll.on, [
  "audit.view_audit",
  "audit.export_audit",
  "members.invite",
  "members.remove",
  "members.change_role",
  "configuration.create_document_type",
  "configuration.edit_document_type",
  "configuration.delete_document_type",
  "configuration.edit_metadata_schema",
  "configuration.edit_rules",
]);
check("super admin cannot read documents without a membership", superAll.on.includes("documents.view"), false);
check("nor confidential audit events", superAll.on.includes("audit.view_confidential_audit"), false);
check("super admin source", superAll.source, "super_admin");

// 2. Role baseline
check("staff baseline", (await granted(staff)).on, [
  "documents.view", "documents.upload", "documents.download", "documents.preview",
  "sharing.share", "sharing.create_link", "search.search",
]);

// 3. A user with no membership at all
check("non-member gets nothing", (await granted(stranger)).on, []);

// 4. Folder override restricts
await prisma.folderPermission.create({
  data: { folderId: child.id, roleId: staffRole.id, permissions: permissionMapFrom(["documents.view", "documents.preview", "search.search"]) as object },
});
check("override restricts on that folder", (await granted(staff, child.id)).on, [
  "documents.view", "documents.preview", "search.search",
]);
check("sibling folder is unaffected", (await granted(staff, root.id)).on, [
  "documents.view", "documents.upload", "documents.download", "documents.preview",
  "sharing.share", "sharing.create_link", "search.search",
]);

// 5. Inheritance: an override on the parent applies to the child
check("override inherited by descendant", (await granted(staff, grandchild.id)).on, [
  "documents.view", "documents.preview", "search.search",
]);

// 6. An override can never GRANT — this one tries to hand out delete + audit export
await prisma.folderPermission.create({
  data: { folderId: grandchild.id, roleId: staffRole.id, permissions: permissionMapFrom(ALL_PERMISSION_KEYS) as object },
});
check("permissive override cannot grant beyond the role", (await granted(staff, grandchild.id)).on, [
  "documents.view", "documents.preview", "search.search",
]);

// 7. Strictest wins across two restrictive overrides on one path
await prisma.folderPermission.update({
  where: { folderId_roleId: { folderId: grandchild.id, roleId: staffRole.id } },
  data: { permissions: permissionMapFrom(["documents.view", "documents.upload", "search.search"]) as object },
});
check("strictest wins across the chain", (await granted(staff, grandchild.id)).on, ["documents.view", "search.search"]);

// 8. A folder override can't reach a Super Admin's administrative keys — those are
// department-level, and an override only tightens what a role may do with content.
check("folder overrides don't strip a super admin's administrative keys",
  (await granted(admin, grandchild.id)).on.includes("configuration.edit_rules"), true);
check("but a non-member super admin still can't read the folder",
  (await granted(admin, grandchild.id)).on.includes("documents.view"), false);

// 8b. A Super Admin who *is* a member reads through their role, plus the administrative keys.
const adminMembership = await prisma.membership.create({
  data: { organizationId: org.id, userId: superAdminId, departmentId: dept.id, roleId: staffRole.id, status: "active" },
});
const superAsMember = await granted(admin);
check("super admin who is a member reads through their role",
  superAsMember.on.includes("documents.view") && superAsMember.on.includes("documents.upload"), true);
check("and keeps the administrative keys",
  superAsMember.on.includes("configuration.edit_rules"), true);
check("without gaining what the role lacks",
  superAsMember.on.includes("documents.delete"), false);
await prisma.membership.delete({ where: { id: adminMembership.id } });

// 9. Confidential: role inheritance disabled for a non-member who otherwise has a role
const confNonMember = await granted(staff, confidential.id);
check("confidential blocks a non-listed role holder", confNonMember.on, []);
check("confidential flagged", confNonMember.confidential, true);

// 10. Confidential: Super Admin excluded — the one place they cannot reach
const confAdmin = await granted(admin, confidential.id);
check("confidential excludes super admin", confAdmin.on, []);
check("confidential flags for super admin too", confAdmin.confidential, true);

// 11. Confidential inheritance flows down even when the child's own flag is false
check("subfolder of confidential is confidential", (await granted(admin, underConfidential.id)).confidential, true);
check("subfolder of confidential blocks non-members", (await granted(staff, underConfidential.id)).on, []);

// 12. A named member with a role gets their role, minus external link capability
await prisma.confidentialMember.create({ data: { folderId: confidential.id, userId: staffUser.id, isOwner: true } });
const confMember = await granted(staff, confidential.id);
check("named member gets their role minus link/external", confMember.on, [
  "documents.view", "documents.upload", "documents.download", "documents.preview",
  "sharing.share", "search.search",
]);
check("named member source", confMember.source, "confidential_member");
check("named member inherits down the confidential subtree", (await granted(staff, underConfidential.id)).on, [
  "documents.view", "documents.upload", "documents.download", "documents.preview",
  "sharing.share", "search.search",
]);

// 13. A named member with NO role in the department gets the documented read-only floor
await prisma.confidentialMember.create({ data: { folderId: confidential.id, userId: outsider.id } });
check("named member without a role gets the floor", (await granted(stranger, confidential.id)).on, [
  "documents.view", "documents.download", "documents.version_history", "documents.preview", "search.search",
]);

// 14. Cross-tenant: a department id from another organization resolves to nothing
const otherOrg = { userId: staffUser.id, organizationId: "00000000-0000-0000-0000-000000000000", isSuperAdmin: true };
const cross = await resolveEffectivePermissions(prisma, otherOrg, dept.id, null);
check("cross-tenant department resolves to nothing", ALL_PERMISSION_KEYS.filter((k) => cross.permissions[k]), []);

// 15. Query-layer exclusion list
check("exclusion list hides confidential from a non-member", await confidentialFolderIdsToExclude(prisma, stranger, dept.id), []);
check("exclusion list hides confidential from super admin", await confidentialFolderIdsToExclude(prisma, admin, dept.id), [confidential.id]);
await prisma.confidentialMember.deleteMany({ where: { folderId: confidential.id, userId: outsider.id } });
check("exclusion list hides it once membership is removed", await confidentialFolderIdsToExclude(prisma, stranger, dept.id), [confidential.id]);

// ── teardown ──
await prisma.confidentialMember.deleteMany({ where: { folderId: { in: [confidential.id] } } });
await prisma.folderPermission.deleteMany({ where: { folderId: { in: [child.id, grandchild.id] } } });
await prisma.folder.deleteMany({ where: { id: { in: [underConfidential.id, confidential.id, grandchild.id, child.id, root.id] } } });
await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
await prisma.role.deleteMany({ where: { departmentId: dept.id } });
await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
await prisma.department.delete({ where: { id: dept.id } });

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
