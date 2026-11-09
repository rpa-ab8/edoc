import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Env } from "../../config/env.js";
import { logAuditEvent } from "../../lib/audit.js";
import { forgotPassword } from "../auth/auth.service.js";
import type { UpdateOrganizationInput } from "./organization.schemas.js";

export class OrganizationError extends Error {
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
  redis: Redis;
  env: Env;
}

export async function getOrganization(deps: Deps, organizationId: string) {
  const org = await deps.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  return {
    id: org.id,
    name: org.name,
    industry: org.industry,
    subfolderDepthLimit: org.subfolderDepthLimit,
    timeZone: org.timeZone,
    createdAt: org.createdAt,
  };
}

export async function updateOrganization(
  deps: Deps,
  organizationId: string,
  actorUserId: string,
  input: UpdateOrganizationInput,
) {
  const { prisma } = deps;
  const updated = await prisma.organization.update({ where: { id: organizationId }, data: input });

  await logAuditEvent(prisma, {
    organizationId,
    actorUserId,
    action: "config_change",
    targetDescription: "Organization settings updated",
  });

  return {
    id: updated.id,
    name: updated.name,
    industry: updated.industry,
    subfolderDepthLimit: updated.subfolderDepthLimit,
    timeZone: updated.timeZone,
    createdAt: updated.createdAt,
  };
}

export interface DashboardSummary {
  counts: {
    departments: number;
    users: number;
    documents: number;
    storageUsedBytes: string;
  };
  storage: {
    backendType: string;
    status: string;
    lastTestedAt: Date | null;
  } | null;
  departments: {
    id: string;
    name: string;
    memberCount: number;
    documentCount: number;
  }[];
}

// Feature Spec §10A: "counts, never contents" — this must never expose a document list or
// department contents, only aggregate numbers. Confidential-folder documents are deliberately
// INCLUDED in every count below (no is_confidential filter) — Data Model §8.1's rule is that
// confidential events/documents still contribute to totals, they just never appear by name
// anywhere a non-member could see them, and a bare count exposes no name.
//
// Flagged gap: Feature Spec §10A calls for "per-department member, document AND storage
// counts," but the Data Model only tracks storage usage at the organization level in R1
// (`storage_config` is one row per org — per-department storage is explicitly R2). There is no
// schema field to source a per-department storage number from, so it's omitted below rather
// than fabricated; only the org-wide total is real.
export async function getDashboard(deps: Deps, organizationId: string): Promise<DashboardSummary> {
  const { prisma } = deps;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

  const [departments, storageConfig, documentCount, activeMemberships] = await Promise.all([
    prisma.department.findMany({ where: { organizationId, status: "active" } }),
    prisma.storageConfig.findUnique({ where: { organizationId } }),
    prisma.document.count({ where: { organizationId, status: "active" } }),
    prisma.membership.findMany({ where: { organizationId, status: "active" }, select: { userId: true } }),
  ]);

  const userIds = new Set(activeMemberships.map((m) => m.userId));
  userIds.add(org.createdByUserId);

  const departmentSummaries = await Promise.all(
    departments.map(async (dept) => {
      const [memberIds, documentCount] = await Promise.all([
        prisma.membership.findMany({
          where: { departmentId: dept.id, status: "active" },
          select: { userId: true },
          distinct: ["userId"],
        }),
        prisma.document.count({ where: { departmentId: dept.id, status: "active" } }),
      ]);
      return {
        id: dept.id,
        name: dept.name,
        memberCount: memberIds.length,
        documentCount,
      };
    }),
  );

  return {
    counts: {
      departments: departments.length,
      users: userIds.size,
      documents: documentCount,
      storageUsedBytes: (storageConfig?.usedBytes ?? 0n).toString(),
    },
    storage: storageConfig
      ? {
          backendType: storageConfig.backendType,
          status: storageConfig.status,
          lastTestedAt: storageConfig.lastTestedAt,
        }
      : null,
    departments: departmentSummaries,
  };
}

export interface MemberSummary {
  userId: string;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  accountStatus: string;
  departments: { departmentId: string; departmentName: string; roleName: string; status: string }[];
}

// NOTE — scope decision (see DEVELOPMENT_ROADMAP.md Module 1.3): this lists members via the
// `Membership` table, which requires a real department + role to exist (Module 2, not built
// yet). Until then this will only ever show the organization's Super Admin (the creator, who
// is not represented via Membership at all — see Data Model §2.4). That's expected, not a bug:
// the code is correct now and needs no rework once departments exist.
export async function listMembers(deps: Deps, organizationId: string): Promise<MemberSummary[]> {
  const { prisma } = deps;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

  const byUser = new Map<string, MemberSummary>();

  const creator = await prisma.user.findUnique({ where: { id: org.createdByUserId } });
  if (creator) {
    byUser.set(creator.id, {
      userId: creator.id,
      email: creator.email,
      fullName: creator.fullName,
      isSuperAdmin: true,
      accountStatus: creator.status,
      departments: [],
    });
  }

  const memberships = await prisma.membership.findMany({
    where: { organizationId },
    include: { user: true, department: true, role: true },
  });

  for (const m of memberships) {
    const entry = {
      departmentId: m.departmentId,
      departmentName: m.department.name,
      roleName: m.role.name,
      status: m.status,
    };
    const existing = byUser.get(m.userId);
    if (existing) {
      existing.departments.push(entry);
    } else {
      byUser.set(m.userId, {
        userId: m.user.id,
        email: m.user.email,
        fullName: m.user.fullName,
        isSuperAdmin: false,
        accountStatus: m.user.status,
        departments: [entry],
      });
    }
  }

  return [...byUser.values()];
}

/**
 * A minimal directory of everyone in the organization — id, name, email only — available to any
 * member (not just the Super Admin, unlike `listMembers`). It backs the share dialog's recipient
 * picker, where a user may share a document with any person in the org, in any department (bug 1).
 * Deliberately excludes department/role/status detail, which is the Super-Admin-only surface.
 */
export async function listOrgUsers(
  deps: Deps,
  organizationId: string,
): Promise<{ id: string; fullName: string; email: string }[]> {
  const { prisma } = deps;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

  const byId = new Map<string, { id: string; fullName: string; email: string }>();
  const creator = await prisma.user.findUnique({ where: { id: org.createdByUserId } });
  if (creator) byId.set(creator.id, { id: creator.id, fullName: creator.fullName, email: creator.email });

  const memberships = await prisma.membership.findMany({
    where: { organizationId, status: "active" },
    select: { user: { select: { id: true, fullName: true, email: true } } },
  });
  for (const m of memberships) byId.set(m.user.id, m.user);

  return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

async function assertNotSuperAdmin(prisma: PrismaClient, organizationId: string, targetUserId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (org.createdByUserId === targetUserId) {
    throw new OrganizationError(
      400,
      "cannot_modify_super_admin",
      "The organization's Super Admin cannot be disabled or removed.",
    );
  }
}

// Org-wide enable/disable, scoped to this organization only (Data Model §7.3: disabling a
// user in Organization A must have no effect on Organization B) — implemented as flipping
// every Membership this user holds *within this org*, never touching User.status (global).
export async function setMemberEnabled(
  deps: Deps,
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  enabled: boolean,
) {
  const { prisma } = deps;
  await assertNotSuperAdmin(prisma, organizationId, targetUserId);

  const result = await prisma.membership.updateMany({
    where: { organizationId, userId: targetUserId, status: enabled ? "disabled" : "active" },
    data: { status: enabled ? "active" : "disabled" },
  });

  if (result.count === 0) {
    throw new OrganizationError(
      404,
      "member_not_found",
      "This user has no membership in this organization to update.",
    );
  }

  await logAuditEvent(prisma, {
    organizationId,
    actorUserId,
    action: "member_change",
    targetDescription: `Member ${enabled ? "enabled" : "disabled"} (${result.count} membership${result.count === 1 ? "" : "s"})`,
  });

  return { updated: result.count };
}

export async function resetMemberPassword(
  deps: Deps,
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
) {
  const { prisma, redis, env } = deps;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const isMember =
    org.createdByUserId === targetUserId ||
    (await prisma.membership.findFirst({ where: { organizationId, userId: targetUserId } })) !== null;
  if (!isMember) {
    throw new OrganizationError(404, "member_not_found", "This user is not a member of this organization.");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
  await forgotPassword({ prisma, redis, env }, user.email);

  await logAuditEvent(prisma, {
    organizationId,
    actorUserId,
    action: "member_change",
    targetDescription: `Password reset triggered for ${user.email}`,
  });

  return { sent: true };
}
