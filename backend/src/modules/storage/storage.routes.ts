import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { storageConfigSchema } from "./storage.schemas.js";
import * as storageService from "./storage.service.js";
import { StorageConfigError } from "./storage.service.js";

function handleStorageError(err: unknown, reply: FastifyReply) {
  if (err instanceof StorageConfigError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

export default async function storageRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma, env: app.env };

  app.get(
    "/config",
    { preHandler: [app.authenticate, app.requireOrganization] },
    async (request, reply) => {
      const status = await storageService.getStorageStatus(deps, request.user!.organizationId!);
      return reply.send({ storage: status });
    },
  );

  // Re-tests the saved connection. POST rather than GET because it performs real writes and
  // deletes against the backend and updates the stored status.
  app.post(
    "/config/test",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      try {
        const result = await storageService.retestStorageConfig(
          deps,
          request.user!.organizationId!,
          request.user!.sub,
        );
        return reply.send(result);
      } catch (err) {
        return handleStorageError(err, reply);
      }
    },
  );

  app.post(
    "/config",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const body = storageConfigSchema.parse(request.body);
      try {
        const result = await storageService.testAndSaveStorageConfig(
          deps,
          request.user!.organizationId!,
          request.user!.sub,
          body,
        );
        return reply.send(result);
      } catch (err) {
        return handleStorageError(err, reply);
      }
    },
  );
}
