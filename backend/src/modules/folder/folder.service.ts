import type { PrismaClient } from "@prisma/client";
import { logAuditEvent } from "../../lib/audit.js";
import {
  confidentialFolderIdsToExclude,
  resolveEffectivePermissions,
  type PermissionActor,
} from "../../lib/effective-permissions.js";
import {
  ALL_PERMISSION_KEYS,
  emptyPermissionMap,
  isKnownPermissionKey,
  type PermissionKey,
  type PermissionMap,
} from "../../lib/permissions.js";

export class FolderError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  prisma: PrismaClient;
}

export interface FolderNode {
  id: string;
  name: string;
  parentFolderId: string | null;
  depth: number;
  isConfidential: boolean;
  subfolderCount: number;
  documentCount: number;
}

async function requireDepartment(deps: Deps, actor: PermissionActor, departmentId: string) {
  const department = await deps.prisma.department.findFirst({
    where: { id: departmentId, organizationId: actor.organizationId },
  });
  if (!department) throw new FolderError(404, "department_not_found", "Department not found.");
  return department;
}

/**
 * The department's effective subfolder depth limit: its own override, else the organization
 * default (Data Model §4.1). Read at creation time only — lowering it later must never orphan
 * folders that already exist (FLD-2).
 */
async function effectiveDepthLimit(deps: Deps, departmentId: string, organizationId: string) {
  const [department, organization] = await Promise.all([
    deps.prisma.department.findUniqueOrThrow({ where: { id: departmentId } }),
    deps.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  return department.subfolderDepthLimit ?? organization.subfolderDepthLimit;
}

/**
 * Every folder in the department the actor is allowed to know about.
 *
 * Confidential folders they are not named on are removed here, at the query layer — a CLAUDE.md
 * hard rule, and the reason this returns a filtered list rather than the caller filtering later.
 * A folder whose *ancestor* is hidden is dropped too, otherwise a subfolder would leak the
 * existence of the confidential parent it hangs from.
 */
export async function listFolders(deps: Deps, actor: PermissionActor, departmentId: string) {
  await requireDepartment(deps, actor, departmentId);
  const { prisma } = deps;

  const [folders, hiddenIds] = await Promise.all([
    prisma.folder.findMany({
      where: { organizationId: actor.organizationId, departmentId },
      orderBy: [{ depth: "asc" }, { name: "asc" }],
    }),
    confidentialFolderIdsToExclude(prisma, actor, departmentId),
  ]);

  const hidden = new Set(hiddenIds);
  const byId = new Map(folders.map((f) => [f.id, f]));

  const isVisible = (folderId: string): boolean => {
    let current = byId.get(folderId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (hidden.has(current.id)) return false;
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return true;
  };

  const visible = folders.filter((f) => isVisible(f.id));

  const counts = await Promise.all(
    visible.map(async (folder) => ({
      id: folder.id,
      subfolderCount: visible.filter((f) => f.parentFolderId === folder.id).length,
      documentCount: await prisma.document.count({ where: { folderId: folder.id, status: "active" } }),
    })),
  );

  return visible.map<FolderNode>((folder) => {
    const count = counts.find((c) => c.id === folder.id)!;
    return {
      id: folder.id,
      name: folder.name,
      parentFolderId: folder.parentFolderId,
      depth: folder.depth,
      isConfidential: folder.isConfidential,
      subfolderCount: count.subfolderCount,
      documentCount: count.documentCount,
    };
  });
}

/** Root → folder, for the breadcrumb. Refuses a folder the actor may not see. */
export async function folderPath(deps: Deps, actor: PermissionActor, folderId: string) {
  // A folder id belonging to another organization must surface as an ordinary `folder_not_found`,
  // not as a raw Prisma P2025 the global error handler would report as a 500 — the boundary is a
  // normal, expected outcome, and a 500 both looks like a defect and answers a different question
  // than a 404 does.
  const owner = await deps.prisma.folder.findFirst({
    where: { id: folderId, organizationId: actor.organizationId },
    select: { departmentId: true },
  });
  if (!owner) throw new FolderError(404, "folder_not_found", "Folder not found.");

  const resolved = await resolveEffectivePermissions(deps.prisma, actor, owner.departmentId, folderId);
  if (resolved.permissions["documents.view"] !== true) {
    // Same response as a missing folder: a confidential folder is invisible entirely, so
    // "forbidden" would confirm it exists.
    throw new FolderError(404, "folder_not_found", "Folder not found.");
  }

  const path: { id: string; name: string }[] = [];
  let currentId: string | null = folderId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const folder: { id: string; name: string; parentFolderId: string | null } | null =
      await deps.prisma.folder.findFirst({
        where: { id: currentId, organizationId: actor.organizationId },
        select: { id: true, name: true, parentFolderId: true },
      });
    if (!folder) break;
    path.unshift({ id: folder.id, name: folder.name });
    currentId = folder.parentFolderId;
  }
  return path;
}

export async function createFolder(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  input: {
    name: string;
    parentFolderId?: string | null;
    /** Create this folder as a confidential vault (CNF-1). Ignored when the parent is already
     *  confidential — the child inherits confidentiality and the ancestor's named list. */
    isConfidential?: boolean;
    /** Named users to seed the vault with, alongside the creator (who is always added as owner).
     *  Only meaningful when this folder *begins* a confidential branch. */
    memberUserIds?: string[];
  },
) {
  const { prisma } = deps;
  await requireDepartment(deps, actor, departmentId);

  let depth = 0;
  let parentIsConfidential = false;

  if (input.parentFolderId) {
    const parent = await prisma.folder.findFirst({
      where: { id: input.parentFolderId, organizationId: actor.organizationId, departmentId },
    });
    if (!parent) throw new FolderError(404, "parent_not_found", "That parent folder doesn't exist.");

    // Confidentiality flows down and cannot be downgraded (Data Model §4.1) — a child of a
    // confidential folder is confidential from the moment it is created.
    parentIsConfidential = parent.isConfidential;
    depth = parent.depth + 1;

    const limit = await effectiveDepthLimit(deps, departmentId, actor.organizationId);
    if (depth > limit) {
      throw new FolderError(
        400,
        "depth_limit_reached",
        `Folders can be nested ${limit} level${limit === 1 ? "" : "s"} deep in this department.`,
      );
    }
  }

  // A folder is confidential if its parent is (inherited) or it is explicitly created as one. It
  // *begins* a confidential branch only in the latter case — that is where the named list lives; an
  // inherited-confidential child reads its members from the confidential ancestor, so it gets no
  // rows of its own.
  const beginsConfidential = input.isConfidential === true && !parentIsConfidential;
  const isConfidential = parentIsConfidential || beginsConfidential;

  // Validate seed members (must be real users in this organization) before creating anything.
  let seedMemberIds: string[] = [];
  if (beginsConfidential) {
    const requested = [...new Set((input.memberUserIds ?? []).filter((id) => id !== actor.userId))];
    if (requested.length > 0) {
      const found = await prisma.user.findMany({
        where: { id: { in: requested }, memberships: { some: { organizationId: actor.organizationId } } },
        select: { id: true },
      });
      if (found.length !== requested.length) {
        throw new FolderError(400, "invalid_member", "One or more selected people aren't in this organization.");
      }
      seedMemberIds = found.map((u) => u.id);
    }
  }

  const clash = await prisma.folder.findFirst({
    where: {
      organizationId: actor.organizationId,
      departmentId,
      parentFolderId: input.parentFolderId ?? null,
      name: input.name,
    },
  });
  if (clash) {
    throw new FolderError(409, "folder_name_taken", "A folder with that name is already here.");
  }

  const folder = await prisma.$transaction(async (tx) => {
    const created = await tx.folder.create({
      data: {
        organizationId: actor.organizationId,
        departmentId,
        parentFolderId: input.parentFolderId ?? null,
        name: input.name,
        depth,
        isConfidential,
      },
    });
    if (beginsConfidential) {
      // The creator is the owner and cannot later be removed (anti-orphaning, CNF-1).
      await tx.confidentialMember.create({
        data: { folderId: created.id, userId: actor.userId, isOwner: true },
      });
      for (const userId of seedMemberIds) {
        await tx.confidentialMember.create({ data: { folderId: created.id, userId, isOwner: false } });
      }
    }
    return created;
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId,
    targetDescription: `${beginsConfidential ? "Confidential folder" : "Folder"} created: ${folder.name}`,
    isConfidential,
  });

  return folder;
}

async function loadFolder(deps: Deps, actor: PermissionActor, folderId: string) {
  const folder = await deps.prisma.folder.findFirst({
    where: { id: folderId, organizationId: actor.organizationId },
  });
  if (!folder) throw new FolderError(404, "folder_not_found", "Folder not found.");
  return folder;
}

export async function renameFolder(
  deps: Deps,
  actor: PermissionActor,
  folderId: string,
  name: string,
) {
  const { prisma } = deps;
  const folder = await loadFolder(deps, actor, folderId);

  const clash = await prisma.folder.findFirst({
    where: {
      organizationId: actor.organizationId,
      departmentId: folder.departmentId,
      parentFolderId: folder.parentFolderId,
      name,
      id: { not: folderId },
    },
  });
  if (clash) throw new FolderError(409, "folder_name_taken", "A folder with that name is already here.");

  const updated = await prisma.folder.update({ where: { id: folderId }, data: { name } });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId: folder.departmentId,
    targetDescription: `Folder renamed: ${folder.name} → ${name}`,
    isConfidential: folder.isConfidential,
  });

  return updated;
}

/**
 * Moves a folder under a new parent. Permissions re-resolve from the new position automatically,
 * because the engine walks the live chain rather than storing anything (FLD-4).
 */
export async function moveFolder(
  deps: Deps,
  actor: PermissionActor,
  folderId: string,
  newParentId: string | null,
) {
  const { prisma } = deps;
  const folder = await loadFolder(deps, actor, folderId);

  if (newParentId === folderId) {
    throw new FolderError(400, "invalid_move", "A folder can't be moved inside itself.");
  }

  let newDepth = 0;
  let newParent = null;
  if (newParentId) {
    newParent = await prisma.folder.findFirst({
      where: {
        id: newParentId,
        organizationId: actor.organizationId,
        departmentId: folder.departmentId,
      },
    });
    if (!newParent) throw new FolderError(404, "parent_not_found", "That destination doesn't exist.");

    // A folder cannot be moved into its own subtree — that would detach the whole branch from
    // the root and leave it unreachable.
    const descendants = await collectDescendants(deps, actor.organizationId, folderId);
    if (descendants.has(newParentId)) {
      throw new FolderError(400, "invalid_move", "A folder can't be moved into one of its own subfolders.");
    }
    newDepth = newParent.depth + 1;
  }

  const clash = await prisma.folder.findFirst({
    where: {
      organizationId: actor.organizationId,
      departmentId: folder.departmentId,
      parentFolderId: newParentId,
      name: folder.name,
      id: { not: folderId },
    },
  });
  if (clash) {
    throw new FolderError(409, "folder_name_taken", "A folder with that name is already in the destination.");
  }

  // Depth is checked for the deepest descendant, not just the folder being moved: dropping a
  // three-level branch one level down can push its leaves past the limit.
  const limit = await effectiveDepthLimit(deps, folder.departmentId, actor.organizationId);
  const subtree = await prisma.folder.findMany({
    where: { organizationId: actor.organizationId, departmentId: folder.departmentId },
  });
  const shift = newDepth - folder.depth;
  const descendantIds = await collectDescendants(deps, actor.organizationId, folderId);
  const deepest = subtree
    .filter((f) => f.id === folderId || descendantIds.has(f.id))
    .reduce((max, f) => Math.max(max, f.depth + shift), 0);
  if (deepest > limit) {
    throw new FolderError(
      400,
      "depth_limit_reached",
      `That move would nest folders deeper than this department's limit of ${limit}.`,
    );
  }

  // Confidentiality is a property of where a folder sits: moving into a confidential branch makes
  // it confidential, and it can never be downgraded by moving out again.
  const becomesConfidential = folder.isConfidential || (newParent?.isConfidential ?? false);

  await prisma.$transaction(async (tx) => {
    await tx.folder.update({
      where: { id: folderId },
      data: { parentFolderId: newParentId, depth: newDepth, isConfidential: becomesConfidential },
    });
    for (const id of descendantIds) {
      const descendant = subtree.find((f) => f.id === id);
      if (!descendant) continue;
      await tx.folder.update({
        where: { id },
        data: {
          depth: descendant.depth + shift,
          isConfidential: descendant.isConfidential || becomesConfidential,
        },
      });
    }
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId: folder.departmentId,
    targetDescription: `Folder moved: ${folder.name}`,
    isConfidential: becomesConfidential,
  });

  return { moved: true };
}

async function collectDescendants(deps: Deps, organizationId: string, folderId: string) {
  const all = await deps.prisma.folder.findMany({
    where: { organizationId },
    select: { id: true, parentFolderId: true },
  });
  const descendants = new Set<string>();
  let frontier = [folderId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const child of all.filter((f) => f.parentFolderId && frontier.includes(f.parentFolderId))) {
      if (!descendants.has(child.id)) {
        descendants.add(child.id);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return descendants;
}

export async function deleteFolder(deps: Deps, actor: PermissionActor, folderId: string) {
  const { prisma } = deps;
  const folder = await loadFolder(deps, actor, folderId);

  const [childCount, documentCount] = await Promise.all([
    prisma.folder.count({ where: { parentFolderId: folderId } }),
    prisma.document.count({ where: { folderId } }),
  ]);

  // `folder` has no soft-delete column in the data model, so this is a real delete — which is
  // only safe while the folder is empty. Documents have their own trash (Module 11); a folder
  // delete must never take documents with it.
  if (childCount > 0) {
    throw new FolderError(409, "folder_not_empty", "Empty this folder's subfolders first.");
  }
  if (documentCount > 0) {
    throw new FolderError(
      409,
      "folder_not_empty",
      `This folder still holds ${documentCount} document${documentCount === 1 ? "" : "s"}.`,
    );
  }

  await prisma.folderPermission.deleteMany({ where: { folderId } });
  await prisma.confidentialMember.deleteMany({ where: { folderId } });
  await prisma.folder.delete({ where: { id: folderId } });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "delete",
    departmentId: folder.departmentId,
    targetDescription: `Folder deleted: ${folder.name}`,
    isConfidential: folder.isConfidential,
  });

  return { deleted: true };
}

/**
 * What the caller may do in this department (optionally in one folder). The UI reads this to
 * decide which controls exist at all — a Viewer should see a genuinely read-only screen, not a
 * screen of disabled buttons (Feature Spec §10B).
 */
export async function myPermissions(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  folderId?: string,
) {
  await requireDepartment(deps, actor, departmentId);
  const resolved = await resolveEffectivePermissions(deps.prisma, actor, departmentId, folderId);
  // The caller's role name in this department, so the workspace can show "you're a <role> here"
  // (bug 7). A Super Admin acting without a membership has no role — surfaced as null.
  const role = resolved.roleId
    ? await deps.prisma.role.findUnique({ where: { id: resolved.roleId }, select: { name: true } })
    : null;
  return {
    permissions: resolved.permissions,
    source: resolved.source,
    isConfidential: resolved.isConfidential,
    roleName: role?.name ?? null,
    // The department's effective limit (own override, else org default). The UI uses it to hide
    // "New subfolder" on a folder already at the limit — the API still enforces it, but offering a
    // button that can only fail is a worse experience than not offering it.
    subfolderDepthLimit: await effectiveDepthLimit(deps, departmentId, actor.organizationId),
  };
}

// ─────────────────────────── folder permission overrides (FLD-3) ───────────────────────────
//
// Breaking inheritance on a folder: a role's access there can be *restricted*, never granted beyond
// what the role holds (Feature Spec §2A.6, a CLAUDE.md hard rule). The engine already reads these
// and intersects them with the role baseline; this is the CRUD that produces them.
//
// A stored override is a full permission map where a restricted key is `false` and everything else
// is `true`. Storing "all true except the restricted keys" (rather than only the allowed subset)
// keeps it future-proof: a permission later added to the role passes straight through the override
// (`true`) and is inherited, instead of being silently withheld because the override predates it.

function overrideMapFromRestricted(restrict: PermissionKey[]): PermissionMap {
  const map = emptyPermissionMap();
  for (const key of ALL_PERMISSION_KEYS) map[key] = true;
  for (const key of restrict) if (isKnownPermissionKey(key)) map[key] = false;
  return map;
}

/** The keys an override withholds — i.e. where the stored map is explicitly `false`. */
function restrictedKeysFrom(stored: unknown): PermissionKey[] {
  if (typeof stored !== "object" || stored === null) return [];
  const map = stored as Record<string, unknown>;
  return ALL_PERMISSION_KEYS.filter((k) => map[k] === false);
}

async function loadOverridableFolder(deps: Deps, actor: PermissionActor, folderId: string) {
  const folder = await loadFolder(deps, actor, folderId);
  // Confidential folders are a distinct mode — inheritance is disabled entirely, so ordinary
  // role-based overrides don't apply there (Feature Spec §11 / §2A.6).
  if (folder.isConfidential) {
    throw new FolderError(400, "confidential_folder", "Confidential folders use a named list, not role overrides.");
  }
  return folder;
}

/**
 * The override picture for a folder: every role in its department, each role's baseline permissions,
 * and which keys (if any) this folder withholds from that role. Gated at the route to Department
 * Admins.
 */
export async function listFolderPermissions(deps: Deps, actor: PermissionActor, folderId: string) {
  const { prisma } = deps;
  const folder = await loadOverridableFolder(deps, actor, folderId);

  const [roles, overrides] = await Promise.all([
    prisma.role.findMany({
      where: { organizationId: actor.organizationId, departmentId: folder.departmentId },
      orderBy: { name: "asc" },
    }),
    prisma.folderPermission.findMany({ where: { folderId } }),
  ]);
  const overrideByRole = new Map(overrides.map((o) => [o.roleId, o]));

  return {
    folderId,
    folderName: folder.name,
    roles: roles.map((r) => {
      const override = overrideByRole.get(r.id);
      return {
        roleId: r.id,
        roleName: r.name,
        basePermissions: r.permissions as PermissionMap,
        hasOverride: Boolean(override),
        restrictedKeys: override ? restrictedKeysFrom(override.permissions) : [],
      };
    }),
  };
}

/** Sets (or replaces) a folder's override for one role, restricting the given keys. An empty
 *  `restrict` clears the override — the role goes back to plain inheritance. */
export async function setFolderPermission(
  deps: Deps,
  actor: PermissionActor,
  folderId: string,
  roleId: string,
  restrict: PermissionKey[],
) {
  const { prisma } = deps;
  const folder = await loadOverridableFolder(deps, actor, folderId);

  const role = await prisma.role.findFirst({
    where: { id: roleId, organizationId: actor.organizationId, departmentId: folder.departmentId },
    select: { id: true, name: true },
  });
  if (!role) throw new FolderError(404, "role_not_found", "That role doesn't belong to this folder's department.");

  const known = restrict.filter((k) => isKnownPermissionKey(k));

  if (known.length === 0) {
    // Nothing restricted means no override — remove any existing one (restore inheritance).
    await prisma.folderPermission.deleteMany({ where: { folderId, roleId } });
  } else {
    const permissions = overrideMapFromRestricted(known) as object;
    await prisma.folderPermission.upsert({
      where: { folderId_roleId: { folderId, roleId } },
      update: { permissions },
      create: { folderId, roleId, permissions },
    });
  }

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "permission_change",
    departmentId: folder.departmentId,
    targetDescription:
      known.length === 0
        ? `Cleared folder override for ${role.name} on ${folder.name}`
        : `Restricted ${role.name} on ${folder.name} (${known.length} permission${known.length === 1 ? "" : "s"})`,
  });

  return listFolderPermissions(deps, actor, folderId);
}

/** Removes a role's override on a folder — it inherits from its parent again. */
export async function clearFolderPermission(
  deps: Deps,
  actor: PermissionActor,
  folderId: string,
  roleId: string,
) {
  return setFolderPermission(deps, actor, folderId, roleId, []);
}
