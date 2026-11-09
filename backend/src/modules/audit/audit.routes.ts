import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as auditService from "./audit.service.js";
import { AuditError, type AuditFilters } from "./audit.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";

const AUDIT_ACTIONS = [
  "view", "upload", "download", "edit", "delete", "restore", "share", "link_access",
  "role_change", "member_change", "config_change", "permission_change", "workflow_transition",
  "auto_delete", "purge", "legal_hold_placed", "legal_hold_removed", "retention_change",
] as const;

const filtersSchema = z.object({
  actorUserId: z.string().uuid().optional(),
  actorType: z.enum(["user", "system"]).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  documentQuery: z.string().trim().min(1).max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handle(err: unknown, reply: FastifyReply) {
  if (err instanceof AuditError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

function parseFilters(query: unknown): AuditFilters {
  const q = filtersSchema.parse(query ?? {});
  return {
    actorUserId: q.actorUserId,
    actorType: q.actorType,
    action: q.action,
    documentQuery: q.documentQuery,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    limit: q.limit,
  };
}

/** Audit-viewer routes, mounted under /departments so `requirePermission` resolves the department. */
export function auditRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  app.get(
    "/:departmentId/audit",
    { preHandler: [...inOrg, app.requirePermission("audit.view_audit")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      try {
        const result = await auditService.listAudit(deps, actorFrom(request), departmentId, parseFilters(request.query));
        return reply.send(result);
      } catch (err) {
        return handle(err, reply);
      }
    },
  );

  // Export is gated by the *separate* export permission (AUD-4) — a View-audit-only Auditor is
  // refused here at the route, before any records are read.
  app.get(
    "/:departmentId/audit/export",
    { preHandler: [...inOrg, app.requirePermission("audit.export_audit")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      try {
        const csv = await auditService.exportAudit(deps, actorFrom(request), departmentId, parseFilters(request.query));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", `attachment; filename="audit-${departmentId}.csv"`);
        return reply.send(csv);
      } catch (err) {
        return handle(err, reply);
      }
    },
  );
}
