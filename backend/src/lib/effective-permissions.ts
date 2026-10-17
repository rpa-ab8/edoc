import type { PrismaClient } from "@prisma/client";
import {
  ALL_PERMISSION_KEYS,
  emptyPermissionMap,
  type PermissionKey,
  type PermissionMap,
} from "./permissions.js";

/**
 * The effective-permission engine — the single place the resolution rule lives.
 *
 * Feature Spec §2A.5, PRD §9, and CLAUDE.md's hard rules all state the same fixed order, and it
 * must not be reordered:
 *
 *   1. The user's single role in that department sets the baseline.
 *   2. A folder override may only *restrict* it further — strictest wins, never a grant.
 *   3. A confidential folder ignores both: access is the named list only, and Super Admin is
 *      excluded entirely.
 *
 * Super Admin sits outside the departmental chain (so it bypasses steps 1 and 2) but is *inside*
 * rule 3 — the confidential exclusion is the one place a Super Admin cannot reach.
 *
 * Every protected route resolves through this function. Nothing else may re-derive permissions.
 */

export interface PermissionActor {
  userId: string;
  organizationId: string;
  isSuperAdmin: boolean;
}

export type PermissionSource =
  | "super_admin"
  | "role"
  | "role_restricted_by_folder"
  | "confidential_member"
  | "none";

export interface EffectivePermissions {
  permissions: PermissionMap;
  source: PermissionSource;
  /** True when the folder (or an ancestor) is confidential — callers use this to exclude it from listings. */
  isConfidential: boolean;
  /** The role the baseline came from, when there is one. */
  roleId?: string;
}

/**
 * What a Super Admin can do in a department they are **not a member of**: administer it, not read
 * it. They configure the department, manage its roles and members, and see its audit trail — but
 * they cannot open its documents or folders until someone gives them a role like anyone else.
 *
 * DEVIATION FROM THE DOCS, made deliberately on the user's instruction (2026-07-23). Feature Spec
 * §2A.1 says the Super Admin "can act in any department regardless of its role matrix". The user
 * overruled that for security: an organization owner should be able to *grant* access without
 * silently *having* it, so that reading a department's files always leaves a membership behind as
 * the record of who could see what. `docs/DMS_Feature_and_Flow_Specification.md` §2A.1 should be
 * amended to match; until it is, this comment is the record of the decision.
 *
 * `audit.view_confidential_audit` is excluded on purpose — the confidential exclusion (§11.2) is
 * unchanged and is the one boundary a Super Admin never crosses.
 */
const SUPER_ADMIN_ADMINISTRATIVE_KEYS: PermissionKey[] = [
  "members.invite",
  "members.remove",
  "members.change_role",
  "configuration.create_document_type",
  "configuration.edit_document_type",
  "configuration.delete_document_type",
  "configuration.edit_metadata_schema",
  "configuration.edit_rules",
  "audit.view_audit",
  "audit.export_audit",
];

function superAdminBaseline(): PermissionMap {
  const map = emptyPermissionMap();
  for (const key of SUPER_ADMIN_ADMINISTRATIVE_KEYS) map[key] = true;
  return map;
}

function union(a: PermissionMap, b: PermissionMap): PermissionMap {
  const map = emptyPermissionMap();
  for (const key of ALL_PERMISSION_KEYS) map[key] = a[key] === true || b[key] === true;
  return map;
}

// Feature Spec §11.2: "External links blocked — a confidential document can never leave by link."
// Enforced here rather than only in the sharing module, so it holds no matter which caller asks.
const BLOCKED_IN_CONFIDENTIAL: PermissionKey[] = ["sharing.external_share", "sharing.create_link"];

// A named member of a confidential folder who holds no role in that department still has to be
// able to do *something* — being on the list would otherwise grant nothing at all. They get a
// documented read-only floor rather than an invented full set.
//
// FLAGGED: the docs define the confidential named list as an access gate (§11.1) but never say
// which capabilities it confers. Deriving them from the member's own department role where one
// exists, and falling back to this floor where it doesn't, is the decision made here.
const CONFIDENTIAL_FLOOR: PermissionKey[] = [
  "documents.view",
  "documents.preview",
  "documents.download",
  "documents.version_history",
  "search.search",
];

interface FolderChainEntry {
  id: string;
  parentFolderId: string | null;
  isConfidential: boolean;
}

/** Walks a folder to the root, nearest-first. Bounded so a cyclic parent pointer can't hang a request. */
async function loadFolderChain(
  prisma: PrismaClient,
  organizationId: string,
  folderId: string,
): Promise<FolderChainEntry[]> {
  const chain: FolderChainEntry[] = [];
  const seen = new Set<string>();
  let currentId: string | null = folderId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const folder: FolderChainEntry | null = await prisma.folder.findFirst({
      // Tenant isolation: a folder id from a request is never trusted on its own.
      where: { id: currentId, organizationId },
      select: { id: true, parentFolderId: true, isConfidential: true },
    });
    if (!folder) break;
    chain.push(folder);
    currentId = folder.parentFolderId;
  }
  return chain;
}

export async function resolveEffectivePermissions(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId: string,
  folderId?: string | null,
): Promise<EffectivePermissions> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!department) {
    return { permissions: emptyPermissionMap(), source: "none", isConfidential: false };
  }

  const chain = folderId ? await loadFolderChain(prisma, actor.organizationId, folderId) : [];
  // Confidentiality flows down (Data Model §4.1). The named list can sit on *any* confidential
  // folder in the chain, so all of them are considered: being named on an outer vault reaches
  // everything inside it, and being named on an inner folder reaches that folder.
  //
  // Checking only the nearest confidential ancestor was wrong, and the folder module found it:
  // once folder creation started propagating `is_confidential` to children (as the data model
  // requires), the nearest confidential ancestor of a child *is the child*, which carries no
  // member rows of its own — so a legitimate member of the parent vault was locked out of
  // everything inside it.
  const confidentialAncestors = chain.filter((f) => f.isConfidential).map((f) => f.id);

  if (confidentialAncestors.length > 0) {
    return resolveConfidential(prisma, actor, departmentId, confidentialAncestors);
  }

  // ── Step 1: baseline ──
  const membership = await prisma.membership.findFirst({
    where: { organizationId: actor.organizationId, departmentId, userId: actor.userId, status: "active" },
    include: { role: true },
  });

  if (!membership) {
    // A Super Admin with no membership administers the department without being able to read it;
    // anyone else with no membership has nothing at all.
    return actor.isSuperAdmin
      ? { permissions: superAdminBaseline(), source: "super_admin", isConfidential: false }
      : { permissions: emptyPermissionMap(), source: "none", isConfidential: false };
  }

  // A Super Admin who *is* a member reads the department through their role, exactly like any
  // other member — plus the administrative keys they hold by virtue of owning the organization.
  const baseline = actor.isSuperAdmin
    ? union(normalize(membership.role.permissions), superAdminBaseline())
    : normalize(membership.role.permissions);

  // ── Step 2: folder overrides restrict, never grant ──
  if (chain.length === 0) {
    return { permissions: baseline, source: "role", isConfidential: false, roleId: membership.roleId };
  }

  const overrides = await prisma.folderPermission.findMany({
    where: { folderId: { in: chain.map((f) => f.id) }, roleId: membership.roleId },
    select: { permissions: true },
  });

  if (overrides.length === 0) {
    // No override anywhere up the chain means plain inheritance from the role (Feature Spec §2A.6).
    return { permissions: baseline, source: "role", isConfidential: false, roleId: membership.roleId };
  }

  // Every override on the path applies, and each can only take away — so the result is the
  // intersection of the baseline with all of them. Order is irrelevant precisely because they
  // can only restrict; that is what makes "strictest wins" well-defined.
  const effective = { ...baseline };
  for (const override of overrides) {
    const restricted = normalize(override.permissions);
    for (const key of ALL_PERMISSION_KEYS) {
      effective[key] = effective[key] === true && restricted[key] === true;
    }
  }

  return {
    // A folder override tightens what a *role* can do with content. It has no business removing
    // an organization owner's administrative rights, which are department-level, so those are
    // re-applied after the intersection.
    permissions: actor.isSuperAdmin ? union(effective, superAdminBaseline()) : effective,
    source: "role_restricted_by_folder",
    isConfidential: false,
    roleId: membership.roleId,
  };
}

async function resolveConfidential(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId: string,
  confidentialFolderIds: string[],
): Promise<EffectivePermissions> {
  // Feature Spec §11.2: "Super Admin excluded — the one place the Super Admin cannot reach."
  // Checked before the member lookup so it can never be short-circuited by anything below.
  if (actor.isSuperAdmin) {
    return { permissions: emptyPermissionMap(), source: "none", isConfidential: true };
  }

  const member = await prisma.confidentialMember.findFirst({
    where: { folderId: { in: confidentialFolderIds }, userId: actor.userId },
    select: { id: true },
  });
  if (!member) {
    // Role inheritance is disabled entirely — holding any role in the department means nothing here.
    return { permissions: emptyPermissionMap(), source: "none", isConfidential: true };
  }

  const membership = await prisma.membership.findFirst({
    where: { organizationId: actor.organizationId, departmentId, userId: actor.userId, status: "active" },
    include: { role: true },
  });

  const permissions = membership
    ? normalize(membership.role.permissions)
    : Object.fromEntries(ALL_PERMISSION_KEYS.map((k) => [k, CONFIDENTIAL_FLOOR.includes(k)]));

  for (const key of BLOCKED_IN_CONFIDENTIAL) permissions[key] = false;

  return {
    permissions,
    source: "confidential_member",
    isConfidential: true,
    ...(membership ? { roleId: membership.roleId } : {}),
  };
}

function normalize(stored: unknown): PermissionMap {
  const map = emptyPermissionMap();
  if (typeof stored === "object" && stored !== null) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (key in map) map[key] = value === true;
    }
  }
  return map;
}

export async function hasPermission(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId: string,
  key: PermissionKey,
  folderId?: string | null,
): Promise<boolean> {
  const resolved = await resolveEffectivePermissions(prisma, actor, departmentId, folderId);
  return resolved.permissions[key] === true;
}

/**
 * Whether the actor may hand someone a role carrying these permissions: never more than they hold
 * in this department themselves. Without it, `members.invite` alone (which manager-shaped roles
 * carry) would let someone invite or add a Department Admin — granting beyond their own reach. The
 * Super Admin owns the organization and may grant any role.
 */
export async function canGrantRole(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId: string,
  rolePermissions: unknown,
): Promise<boolean> {
  if (actor.isSuperAdmin) return true;
  const { permissions } = await resolveEffectivePermissions(prisma, actor, departmentId);
  const granted = (rolePermissions ?? {}) as Record<string, unknown>;
  return Object.entries(granted).every(([key, on]) => on !== true || permissions[key] === true);
}

/**
 * The set of folder ids in a department that the actor may NOT see, because they are confidential
 * and the actor isn't on the named list. Callers building listing/search/count queries exclude
 * these at the query layer — a CLAUDE.md hard rule is that this is never left to the UI.
 *
 * Super Admin gets the full confidential-folder set back: excluded from contents, while aggregate
 * counts elsewhere still include them (Data Model §8.1 — "the count is visible, the contents are
 * not"), which is why this returns folder ids rather than filtering counts itself.
 */
export async function confidentialFolderIdsToExclude(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId?: string,
): Promise<string[]> {
  const allFolders = await prisma.folder.findMany({
    where: { organizationId: actor.organizationId, ...(departmentId ? { departmentId } : {}) },
    select: { id: true, parentFolderId: true, isConfidential: true },
  });
  const confidentialFolders = allFolders.filter((f) => f.isConfidential);
  if (confidentialFolders.length === 0) return [];

  if (actor.isSuperAdmin) return confidentialFolders.map((f) => f.id);

  const memberships = await prisma.confidentialMember.findMany({
    where: { userId: actor.userId, folderId: { in: confidentialFolders.map((f) => f.id) } },
    select: { folderId: true },
  });
  const namedOn = new Set(memberships.map((m) => m.folderId));

  // Membership on any confidential folder in the chain grants the ones beneath it — matching
  // `resolveEffectivePermissions`. Both must agree, or a folder would be listed and then refused
  // on open (or worse, hidden from a member who genuinely has access).
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  const reachable = (folderId: string): boolean => {
    let current = byId.get(folderId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (namedOn.has(current.id)) return true;
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return false;
  };

  return confidentialFolders.filter((f) => !reachable(f.id)).map((f) => f.id);
}

/**
 * Every folder in a department whose *contents* the actor may not see — the confidential set above,
 * **plus** folders where a permission override withholds `documents.view` from the actor's role.
 *
 * This is what listing and search queries must exclude. `confidentialFolderIdsToExclude` is the
 * narrower set and stays as it is, because aggregate counts legitimately include confidential
 * folders (Data Model §8.1) while a *result list* must not.
 *
 * Why this exists (found by the Module 13 access-control matrix, 2026-07-25): the engine correctly
 * refused a restricted folder's document on open, but search only ever excluded confidential
 * folders — so a user restricted out of a folder still saw its documents' IDs, titles, types and
 * folder names in search results, and only hit the refusal on click. Enforcing a restriction on
 * open but not on listing leaks exactly the metadata the restriction exists to withhold. The same
 * rule the resolver uses applies here: an override anywhere up the chain applies to everything
 * beneath it.
 */
export async function unviewableFolderIdsToExclude(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId: string,
): Promise<string[]> {
  const excluded = new Set(await confidentialFolderIdsToExclude(prisma, actor, departmentId));

  const membership = await prisma.membership.findFirst({
    where: { organizationId: actor.organizationId, departmentId, userId: actor.userId, status: "active" },
    include: { role: true },
  });
  // No membership means no role for an override to modify — a Super Admin's exclusions are the
  // confidential set alone, and a non-member never reaches a listing in the first place.
  if (!membership) return [...excluded];

  const baseline = normalize(membership.role.permissions);
  if (baseline["documents.view"] !== true) return [...excluded];

  const overrides = await prisma.folderPermission.findMany({
    where: {
      roleId: membership.roleId,
      folder: { organizationId: actor.organizationId, departmentId },
    },
    select: { folderId: true, permissions: true },
  });
  const removesView = new Set(
    overrides.filter((o) => normalize(o.permissions)["documents.view"] !== true).map((o) => o.folderId),
  );
  if (removesView.size === 0) return [...excluded];

  const folders = await prisma.folder.findMany({
    where: { organizationId: actor.organizationId, departmentId },
    select: { id: true, parentFolderId: true },
  });
  const byId = new Map(folders.map((f) => [f.id, f]));

  for (const folder of folders) {
    let current = byId.get(folder.id);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (removesView.has(current.id)) {
        excluded.add(folder.id);
        break;
      }
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
  }

  return [...excluded];
}
