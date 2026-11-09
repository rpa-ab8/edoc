import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as retentionService from "./retention.service.js";
import { RetentionError } from "./retention.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";

const periodSchema = z.number().int().min(1).max(100).nullable();
const setPeriodSchema = z.object({ autoDeleteYears: periodSchema, confirm: z.boolean().optional() });
const previewSchema = z.object({ autoDeleteYears: periodSchema });
const holdSchema = z.object({ reason: z.string().max(2000).optional() });

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handle(err: unknown, reply: FastifyReply) {
  if (err instanceof RetentionError) {
    // `details` carries the preview on a 409 confirmation_required — the same slot the client reads.
    return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
  }
  throw err;
}

/**
 * Retention routes (PRD v1.2 RET-1..8). Mounted at the root because they span /departments,
 * /documents and /legal-holds. Every check is made in the service against the permission engine —
 * the Department-Admin rights for the setting and lists, and hold authority (the department right,
 * or a confidential folder's Owner) for holds — never left to the UI.
 */
export async function retentionRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma, env: app.env };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  // ── auto-delete period (RET-1, RET-2, RET-7) ──
  app.get("/departments/:departmentId/retention", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      return reply.send(await retentionService.getAutoDeleteSetting(deps, actorFrom(request), departmentId));
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post("/departments/:departmentId/retention/preview", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    const body = previewSchema.parse(request.body ?? {});
    try {
      return reply.send(
        await retentionService.previewAutoDelete(deps, actorFrom(request), departmentId, body.autoDeleteYears),
      );
    } catch (err) {
      return handle(err, reply);
    }
  });

  // Setting or shortening answers 409 `confirmation_required` with the preview until `confirm: true`.
  app.put("/departments/:departmentId/retention", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    const body = setPeriodSchema.parse(request.body ?? {});
    try {
      return reply.send(await retentionService.setAutoDeletePeriod(deps, actorFrom(request), departmentId, body));
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ── Upcoming Deletions (RET-4) ──
  app.get("/departments/:departmentId/retention/upcoming", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      return reply.send(await retentionService.listUpcomingDeletions(deps, actorFrom(request), departmentId));
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ── Legal Hold (RET-5, RET-6) ──
  app.get("/departments/:departmentId/legal-holds", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      return reply.send({ holds: await retentionService.listHolds(deps, actorFrom(request), departmentId) });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post("/documents/:documentId/legal-hold", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const body = holdSchema.parse(request.body ?? {});
    try {
      const hold = await retentionService.placeDocumentHold(deps, actorFrom(request), documentId, body.reason);
      return reply.code(201).send({ hold });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post("/departments/:departmentId/folders/:folderId/legal-hold", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId, folderId } = request.params as { departmentId: string; folderId: string };
    const body = holdSchema.parse(request.body ?? {});
    try {
      const hold = await retentionService.placeFolderHold(deps, actorFrom(request), departmentId, folderId, body.reason);
      return reply.code(201).send({ hold });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.delete("/legal-holds/:holdId", { preHandler: inOrg }, async (request, reply) => {
    const { holdId } = request.params as { holdId: string };
    try {
      return reply.send(await retentionService.removeHold(deps, actorFrom(request), holdId));
    } catch (err) {
      return handle(err, reply);
    }
  });
}
