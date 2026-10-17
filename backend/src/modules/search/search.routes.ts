import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as searchService from "./search.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";

const filterSchema = z.object({
  fieldDefId: z.string().uuid(),
  op: z.enum(["contains", "exact", "in", "date_range", "number_range"]),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const searchSchema = z.object({
  q: z.string().max(200).optional(),
  documentTypeId: z.string().uuid().optional(),
  quickView: z.enum(["recent", "uploaded_by_me", "shared_with_me", "trash"]).optional(),
  filters: z.array(filterSchema).max(20).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

/**
 * Search, mounted under /departments so `requirePermission` resolves the department from the route.
 * POST rather than GET because the filter set is structured (per-field operators) — a body is far
 * cleaner than encoding it into the query string. It performs no writes.
 */
export default async function searchRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  app.post(
    "/:departmentId/search",
    { preHandler: [...inOrg, app.requirePermission("search.search")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { departmentId } = request.params as { departmentId: string };
      const body = searchSchema.parse(request.body ?? {});
      const results = await searchService.searchDocuments(deps, actorFrom(request), {
        departmentId,
        ...body,
      });
      return reply.send({ results });
    },
  );
}
