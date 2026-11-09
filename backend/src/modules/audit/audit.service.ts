import type { AuditAction, Prisma, PrismaClient } from "@prisma/client";
import { auditActorName } from "../../lib/audit.js";
import { resolveEffectivePermissions, type PermissionActor } from "../../lib/effective-permissions.js";

export class AuditError extends Error {
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

export interface AuditFilters {
  actorUserId?: string;
  /** "system" = only events the scheduled jobs wrote (auto-delete, the automatic trash purge). */
  actorType?: "user" | "system";
  action?: AuditAction;
  /** Free-text match against the event's description (catches a document ref, even after purge). */
  documentQuery?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface AuditEventView {
  id: string;
  action: AuditAction;
  actorType: "user" | "system";
  actorName: string;
  documentRef: string | null;
  targetDescription: string | null;
  isConfidential: boolean;
  occurredAt: Date;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Resolves the caller's audit-related capabilities in a department (the route has already checked
 *  `audit.view_audit`; this reads the two finer grants off the same resolution). */
async function auditCapabilities(deps: Deps, actor: PermissionActor, departmentId: string) {
  const resolved = await resolveEffectivePermissions(deps.prisma, actor, departmentId);
  return {
    canView: resolved.permissions["audit.view_audit"] === true,
    canExport: resolved.permissions["audit.export_audit"] === true,
    canViewConfidential: resolved.permissions["audit.view_confidential_audit"] === true,
  };
}

function buildWhere(
  actor: PermissionActor,
  departmentId: string,
  filters: AuditFilters,
  canViewConfidential: boolean,
): Prisma.AuditEventWhereInput {
  const where: Prisma.AuditEventWhereInput = {
    organizationId: actor.organizationId,
    departmentId,
  };
  // Confidential-folder events are segregated (AUD-5): excluded entirely unless the caller holds the
  // confidential-audit permission — a normal admin never even sees that a confidential doc was touched.
  if (!canViewConfidential) where.isConfidential = false;
  if (filters.actorUserId) where.actorUserId = filters.actorUserId;
  if (filters.actorType) where.actorType = filters.actorType;
  if (filters.action) where.action = filters.action;
  if (filters.documentQuery) {
    where.targetDescription = { contains: filters.documentQuery, mode: "insensitive" };
  }
  if (filters.from || filters.to) {
    where.occurredAt = {};
    if (filters.from) where.occurredAt.gte = filters.from;
    if (filters.to) where.occurredAt.lte = filters.to;
  }
  return where;
}

async function queryEvents(
  deps: Deps,
  where: Prisma.AuditEventWhereInput,
  limit: number,
): Promise<AuditEventView[]> {
  const rows = await deps.prisma.auditEvent.findMany({
    where,
    include: {
      actor: { select: { fullName: true } },
      document: { select: { documentRef: true } },
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
  return rows.map((e) => ({
    id: e.id,
    action: e.action,
    actorType: e.actorType,
    actorName: auditActorName(e),
    documentRef: e.document?.documentRef ?? null,
    targetDescription: e.targetDescription,
    isConfidential: e.isConfidential,
    occurredAt: e.occurredAt,
  }));
}

/**
 * The filterable audit trail for a department (AUD-2). The route gates `audit.view_audit`; this adds
 * the confidential segregation and returns the caller's export capability so the UI can show or hide
 * the export control. Filters combine (all are AND-ed).
 */
export async function listAudit(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  filters: AuditFilters,
): Promise<{ events: AuditEventView[]; canExport: boolean; includesConfidential: boolean }> {
  const caps = await auditCapabilities(deps, actor, departmentId);
  if (!caps.canView) throw new AuditError(403, "forbidden", "You don't have permission to view the audit log.");

  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const where = buildWhere(actor, departmentId, filters, caps.canViewConfidential);
  const events = await queryEvents(deps, where, limit);

  return { events, canExport: caps.canExport, includesConfidential: caps.canViewConfidential };
}

/**
 * The same records as CSV, gated by the separate `audit.export_audit` permission (AUD-4) — an
 * Auditor with only View-audit can inspect but never extract. Confidential events are included only
 * when the caller may see them.
 */
export async function exportAudit(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  filters: AuditFilters,
): Promise<string> {
  const caps = await auditCapabilities(deps, actor, departmentId);
  if (!caps.canView) throw new AuditError(403, "forbidden", "You don't have permission to view the audit log.");
  if (!caps.canExport) throw new AuditError(403, "forbidden", "Exporting the audit log needs the Export-audit permission.");

  const where = buildWhere(actor, departmentId, filters, caps.canViewConfidential);
  const events = await queryEvents(deps, where, MAX_LIMIT);

  const header = ["Time", "Actor", "Action", "Document", "Details", "Confidential"];
  const rows = events.map((e) => [
    e.occurredAt.toISOString(),
    e.actorName,
    e.action,
    e.documentRef ?? "",
    e.targetDescription ?? "",
    e.isConfidential ? "yes" : "no",
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** RFC-4180 cell quoting: wrap in quotes and double any embedded quote when the value contains a
 *  comma, quote or newline. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
