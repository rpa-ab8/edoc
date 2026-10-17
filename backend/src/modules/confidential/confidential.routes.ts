import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as confidentialService from "./confidential.service.js";
import { ConfidentialError } from "./confidential.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";

const memberSchema = z.object({ userId: z.string().uuid() });
const recoverySchema = z.object({ newMemberUserId: z.string().uuid() });

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handle(err: unknown, reply: FastifyReply) {
  if (err instanceof ConfidentialError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Confidential-folder routes (Module 10). Member management is folder-scoped and gated inside the
 * service by vault membership (there is no role-based `requirePermission` here — a confidential
 * folder ignores roles). Recovery is department-scoped and gated by Super-Admin / Department-Admin
 * authority inside the service.
 */
export async function confidentialRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  // ── named-list management (members only) ──
  app.get("/folders/:folderId/confidential/members", { preHandler: inOrg }, async (request, reply) => {
    const { folderId } = request.params as { folderId: string };
    try {
      return reply.send(await confidentialService.listMembers(deps, actorFrom(request), folderId));
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post("/folders/:folderId/confidential/members", { preHandler: inOrg }, async (request, reply) => {
    const { folderId } = request.params as { folderId: string };
    const body = memberSchema.parse(request.body);
    try {
      return reply.send(await confidentialService.addMember(deps, actorFrom(request), folderId, body.userId));
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.delete("/folders/:folderId/confidential/members/:userId", { preHandler: inOrg }, async (request, reply) => {
    const { folderId, userId } = request.params as { folderId: string; userId: string };
    try {
      return reply.send(await confidentialService.removeMember(deps, actorFrom(request), folderId, userId));
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ── dual-control recovery (Super Admin + Department Admin) ──
  app.get("/departments/:departmentId/confidential/orphaned", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      const folders = await confidentialService.listOrphaned(deps, actorFrom(request), departmentId);
      return reply.send({ folders });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.get("/departments/:departmentId/confidential/recoveries", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      const recoveries = await confidentialService.listRecoveries(deps, actorFrom(request), departmentId);
      return reply.send({ recoveries });
    } catch (err) {
      return handle(err, reply);
    }
  });

  app.post(
    "/departments/:departmentId/confidential/folders/:folderId/recovery",
    { preHandler: inOrg },
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      const body = recoverySchema.parse(request.body);
      try {
        const recovery = await confidentialService.initiateRecovery(
          deps,
          actorFrom(request),
          folderId,
          body.newMemberUserId,
        );
        return reply.code(201).send({ recovery });
      } catch (err) {
        return handle(err, reply);
      }
    },
  );

  app.post(
    "/departments/:departmentId/confidential/recoveries/:recoveryId/approve",
    { preHandler: inOrg },
    async (request, reply) => {
      const { recoveryId } = request.params as { recoveryId: string };
      try {
        const recovery = await confidentialService.approveRecovery(deps, actorFrom(request), recoveryId);
        return reply.send({ recovery });
      } catch (err) {
        return handle(err, reply);
      }
    },
  );
}
