import type { PrismaClient } from "@prisma/client";
import { logAuditEvent } from "../../lib/audit.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";
import { hasDepartmentAdminCapability } from "../../lib/permissions.js";

export class ConfidentialError extends Error {
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

// ─────────────────────────── locating the vault ───────────────────────────

interface FolderRow {
  id: string;
  name: string;
  departmentId: string;
  parentFolderId: string | null;
  isConfidential: boolean;
}

/**
 * The folder where confidentiality *begins* for a given folder — the topmost confidential ancestor.
 * The named list lives there; a confidential subfolder inherits it, so all member management is
 * redirected to this root. Returns null if the folder isn't confidential at all.
 */
async function confidentialRoot(deps: Deps, organizationId: string, folderId: string): Promise<FolderRow | null> {
  const byId = new Map<string, FolderRow>();
  let current = await deps.prisma.folder.findFirst({
    where: { id: folderId, organizationId },
    select: { id: true, name: true, departmentId: true, parentFolderId: true, isConfidential: true },
  });
  if (!current || !current.isConfidential) return null;

  const seen = new Set<string>();
  let root = current;
  while (current && current.isConfidential && !seen.has(current.id)) {
    seen.add(current.id);
    byId.set(current.id, current);
    root = current;
    if (!current.parentFolderId) break;
    const parent: FolderRow | null = await deps.prisma.folder.findFirst({
      where: { id: current.parentFolderId, organizationId },
      select: { id: true, name: true, departmentId: true, parentFolderId: true, isConfidential: true },
    });
    if (!parent || !parent.isConfidential) break;
    current = parent;
  }
  return root;
}

async function isMember(deps: Deps, folderId: string, userId: string): Promise<{ id: string; isOwner: boolean } | null> {
  return deps.prisma.confidentialMember.findFirst({
    where: { folderId, userId },
    select: { id: true, isOwner: true },
  });
}

/** Loads the vault root for a folder and confirms the actor is on its named list. Super Admin is
 *  excluded (§11.2) — they can never be a member, so this refuses them like any non-member. */
async function requireVaultMember(deps: Deps, actor: PermissionActor, folderId: string): Promise<FolderRow> {
  const root = await confidentialRoot(deps, actor.organizationId, folderId);
  // A folder the actor can't establish as a confidential vault they belong to is reported as "not
  // found", never "forbidden" — a confidential folder is invisible to non-members (§11.2).
  if (!root) throw new ConfidentialError(404, "folder_not_found", "Folder not found.");
  if (actor.isSuperAdmin) throw new ConfidentialError(404, "folder_not_found", "Folder not found.");
  const member = await isMember(deps, root.id, actor.userId);
  if (!member) throw new ConfidentialError(404, "folder_not_found", "Folder not found.");
  return root;
}

// ─────────────────────────── member management (CNF-1) ───────────────────────────

export interface ConfidentialMemberView {
  userId: string;
  fullName: string;
  email: string;
  isOwner: boolean;
}

export async function listMembers(deps: Deps, actor: PermissionActor, folderId: string) {
  const root = await requireVaultMember(deps, actor, folderId);
  const rows = await deps.prisma.confidentialMember.findMany({
    where: { folderId: root.id },
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { isOwner: "desc" },
  });
  return {
    folderId: root.id,
    folderName: root.name,
    members: rows.map(
      (r): ConfidentialMemberView => ({
        userId: r.user.id,
        fullName: r.user.fullName,
        email: r.user.email,
        isOwner: r.isOwner,
      }),
    ),
  };
}

export async function addMember(deps: Deps, actor: PermissionActor, folderId: string, userId: string) {
  const root = await requireVaultMember(deps, actor, folderId);

  const user = await deps.prisma.user.findFirst({
    where: { id: userId, memberships: { some: { organizationId: actor.organizationId } } },
    select: { id: true, email: true },
  });
  if (!user) throw new ConfidentialError(400, "invalid_member", "That person isn't part of this organization.");

  const existing = await isMember(deps, root.id, userId);
  if (existing) throw new ConfidentialError(409, "already_member", "They're already on this folder's list.");

  await deps.prisma.confidentialMember.create({ data: { folderId: root.id, userId, isOwner: false } });
  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "permission_change",
    departmentId: root.departmentId,
    targetDescription: `Added ${user.email} to confidential folder ${root.name}`,
    isConfidential: true,
  });
  return listMembers(deps, actor, root.id);
}

export async function removeMember(deps: Deps, actor: PermissionActor, folderId: string, userId: string) {
  const root = await requireVaultMember(deps, actor, folderId);

  const target = await isMember(deps, root.id, userId);
  if (!target) throw new ConfidentialError(404, "not_a_member", "They're not on this folder's list.");
  // The owner cannot be removed — the first half of the anti-orphaning guardrail (CNF-1).
  if (target.isOwner) throw new ConfidentialError(400, "cannot_remove_owner", "The folder's owner can't be removed.");

  await deps.prisma.confidentialMember.delete({ where: { id: target.id } });
  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "permission_change",
    departmentId: root.departmentId,
    targetDescription: `Removed a member from confidential folder ${root.name}`,
    isConfidential: true,
  });
  return listMembers(deps, actor, root.id);
}

// ─────────────────────────── dual-control recovery (CNF-4) ───────────────────────────

/** Is the actor a Department Admin of this department (both member-management and rules capability)? */
async function isDepartmentAdmin(deps: Deps, actor: PermissionActor, departmentId: string): Promise<boolean> {
  const membership = await deps.prisma.membership.findFirst({
    where: { organizationId: actor.organizationId, departmentId, userId: actor.userId, status: "active" },
    include: { role: true },
  });
  return membership ? hasDepartmentAdminCapability(membership.role.permissions) : false;
}

/** Only the two recovery authorities may even see that an orphaned vault exists — a deliberate,
 *  narrow exception to invisibility, since recovery is impossible otherwise (§11.3). */
async function requireRecoveryAuthority(deps: Deps, actor: PermissionActor, departmentId: string) {
  // `isSuperAdmin` is a claim about the actor's *own* organization, so it must not be allowed to
  // stand in for authority over a department in another one. The queries downstream are all
  // org-filtered (a foreign department simply yields nothing), but an authority check that passes
  // across the tenant boundary is the wrong shape to leave in place — verify the department first.
  const department = await deps.prisma.department.findFirst({
    where: { id: departmentId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!department) throw new ConfidentialError(404, "department_not_found", "Department not found.");

  const superAdmin = actor.isSuperAdmin;
  const deptAdmin = await isDepartmentAdmin(deps, actor, departmentId);
  if (!superAdmin && !deptAdmin) {
    throw new ConfidentialError(403, "forbidden", "Only a Super Admin or Department Admin can do this.");
  }
  return { superAdmin, deptAdmin };
}

/** Confidential vault roots in a department with **no** members left — genuinely orphaned. */
export async function listOrphaned(deps: Deps, actor: PermissionActor, departmentId: string) {
  await requireRecoveryAuthority(deps, actor, departmentId);
  const folders = await deps.prisma.folder.findMany({
    where: { organizationId: actor.organizationId, departmentId, isConfidential: true },
    select: { id: true, name: true, parentFolderId: true, isConfidential: true, departmentId: true },
  });
  // A vault root is a confidential folder whose parent is not confidential; only roots carry member
  // rows, so only they can be orphaned.
  const byId = new Map(folders.map((f) => [f.id, f]));
  const roots = folders.filter((f) => {
    const parent = f.parentFolderId ? byId.get(f.parentFolderId) : undefined;
    return !parent || !parent.isConfidential;
  });

  const orphaned: { folderId: string; folderName: string }[] = [];
  for (const r of roots) {
    const count = await deps.prisma.confidentialMember.count({ where: { folderId: r.id } });
    if (count === 0) orphaned.push({ folderId: r.id, folderName: r.name });
  }
  return orphaned;
}

export interface RecoveryView {
  id: string;
  folderId: string;
  folderName: string;
  newMemberName: string;
  status: string;
  superAdminApproved: boolean;
  deptAdminApproved: boolean;
  createdAt: Date;
}

async function shapeRecovery(deps: Deps, id: string): Promise<RecoveryView> {
  const r = await deps.prisma.confidentialRecovery.findUniqueOrThrow({
    where: { id },
    include: { folder: { select: { name: true } } },
  });
  const newMember = await deps.prisma.user.findUnique({
    where: { id: r.newMemberUserId },
    select: { fullName: true },
  });
  return {
    id: r.id,
    folderId: r.folderId,
    folderName: r.folder.name,
    newMemberName: newMember?.fullName ?? "Unknown",
    status: r.status,
    superAdminApproved: r.superAdminApprovedByUserId !== null,
    deptAdminApproved: r.deptAdminApprovedByUserId !== null,
    createdAt: r.createdAt,
  };
}

export async function listRecoveries(deps: Deps, actor: PermissionActor, departmentId: string) {
  await requireRecoveryAuthority(deps, actor, departmentId);
  const rows = await deps.prisma.confidentialRecovery.findMany({
    where: {
      organizationId: actor.organizationId,
      status: "pending",
      folder: { departmentId },
    },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(rows.map((r) => shapeRecovery(deps, r.id)));
}

/**
 * Starts a dual-control recovery of an orphaned vault, recording the initiator's own approval. The
 * folder must have zero members (genuinely orphaned), and `newMemberUserId` becomes its owner once
 * the second authority approves.
 */
export async function initiateRecovery(
  deps: Deps,
  actor: PermissionActor,
  folderId: string,
  newMemberUserId: string,
): Promise<RecoveryView> {
  const folder = await deps.prisma.folder.findFirst({
    where: { id: folderId, organizationId: actor.organizationId, isConfidential: true },
    select: { id: true, name: true, departmentId: true, parentFolderId: true },
  });
  if (!folder) throw new ConfidentialError(404, "folder_not_found", "Confidential folder not found.");

  const { superAdmin, deptAdmin } = await requireRecoveryAuthority(deps, actor, folder.departmentId);

  const memberCount = await deps.prisma.confidentialMember.count({ where: { folderId } });
  if (memberCount > 0) {
    throw new ConfidentialError(409, "not_orphaned", "This folder still has members — recovery isn't needed.");
  }

  const newMember = await deps.prisma.user.findFirst({
    where: { id: newMemberUserId, memberships: { some: { organizationId: actor.organizationId } } },
    select: { id: true },
  });
  if (!newMember) throw new ConfidentialError(400, "invalid_member", "The person to grant access to isn't in this organization.");

  const existing = await deps.prisma.confidentialRecovery.findFirst({
    where: { folderId, status: "pending" },
    select: { id: true },
  });
  if (existing) throw new ConfidentialError(409, "recovery_in_progress", "A recovery is already in progress for this folder.");

  const created = await deps.prisma.confidentialRecovery.create({
    data: {
      organizationId: actor.organizationId,
      folderId,
      newMemberUserId,
      initiatedByUserId: actor.userId,
      superAdminApprovedByUserId: superAdmin ? actor.userId : null,
      deptAdminApprovedByUserId: deptAdmin && !superAdmin ? actor.userId : null,
    },
  });

  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "permission_change",
    departmentId: folder.departmentId,
    targetDescription: `Initiated dual-control recovery of confidential folder ${folder.name}`,
    isConfidential: true,
  });
  return shapeRecovery(deps, created.id);
}

/**
 * The second authority approves a pending recovery. Both a Super Admin and a Department Admin must
 * approve, from two distinct people; on the second approval the nominated user is added as owner and
 * the vault is reopened.
 */
export async function approveRecovery(deps: Deps, actor: PermissionActor, recoveryId: string): Promise<RecoveryView> {
  const recovery = await deps.prisma.confidentialRecovery.findFirst({
    where: { id: recoveryId, organizationId: actor.organizationId },
    include: { folder: { select: { id: true, name: true, departmentId: true } } },
  });
  if (!recovery) throw new ConfidentialError(404, "recovery_not_found", "Recovery request not found.");
  if (recovery.status !== "pending") {
    throw new ConfidentialError(409, "not_pending", "This recovery has already been decided.");
  }

  const { superAdmin, deptAdmin } = await requireRecoveryAuthority(deps, actor, recovery.folder.departmentId);

  let superAdminApprover = recovery.superAdminApprovedByUserId;
  let deptAdminApprover = recovery.deptAdminApprovedByUserId;

  if (superAdmin) {
    if (superAdminApprover && superAdminApprover !== actor.userId) {
      // already have a super-admin approval from someone else; nothing to add
    }
    superAdminApprover = superAdminApprover ?? actor.userId;
  }
  if (deptAdmin) {
    deptAdminApprover = deptAdminApprover ?? actor.userId;
  }

  // The two approvals must come from two different people.
  if (superAdminApprover && deptAdminApprover && superAdminApprover === deptAdminApprover) {
    throw new ConfidentialError(400, "distinct_approvers_required", "The two approvals must come from two different people.");
  }

  const complete = Boolean(superAdminApprover) && Boolean(deptAdminApprover);

  await deps.prisma.$transaction(async (tx) => {
    await tx.confidentialRecovery.update({
      where: { id: recovery.id },
      data: {
        superAdminApprovedByUserId: superAdminApprover,
        deptAdminApprovedByUserId: deptAdminApprover,
        ...(complete ? { status: "completed", completedAt: new Date() } : {}),
      },
    });
    if (complete) {
      // Reopen the vault: the nominated person becomes its new owner.
      await tx.confidentialMember.upsert({
        where: { folderId_userId: { folderId: recovery.folderId, userId: recovery.newMemberUserId } },
        update: { isOwner: true },
        create: { folderId: recovery.folderId, userId: recovery.newMemberUserId, isOwner: true },
      });
    }
  });

  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "permission_change",
    departmentId: recovery.folder.departmentId,
    targetDescription: `${complete ? "Completed" : "Approved"} dual-control recovery of confidential folder ${recovery.folder.name}`,
    isConfidential: true,
  });
  return shapeRecovery(deps, recovery.id);
}
