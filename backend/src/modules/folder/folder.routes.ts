import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as folderService from "./folder.service.js";
import { FolderError } from "./folder.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";

const folderNameSchema = z.string().trim().min(1).max(80);

const createFolderSchema = z.object({
  name: folderNameSchema,
  parentFolderId: z.string().uuid().nullable().optional(),
  // Create this folder as a confidential vault (Module 10), optionally seeded with named members
  // alongside the creator (who is always its owner).
  isConfidential: z.boolean().optional(),
  memberUserIds: z.array(z.string().uuid()).max(200).optional(),
});

const renameFolderSchema = z.object({ name: folderNameSchema });
const moveFolderSchema = z.object({ parentFolderId: z.string().uuid().nullable() });
const overrideSchema = z.object({ restrict: z.array(z.string()).max(60) });

// Managing folder overrides is a department-configuration action, so its permission resolves at the
// *department* level, not folder-scoped — otherwise a folder's own override could lock the admin out
// of editing it.
const departmentOnlyTarget = (request: FastifyRequest) => {
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  return { departmentId: params.departmentId };
};

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handleFolderError(err: unknown, reply: FastifyReply) {
  if (err instanceof FolderError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Mounted under /departments/:departmentId so `requirePermission` resolves the department from the
 * route. Folder-scoped actions pass their folder too, so an override on that folder applies.
 */
export default async function folderRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  // Reading the tree needs only the ability to see documents — it is the workspace's spine.
  app.get(
    "/:departmentId/folders",
    { preHandler: [...inOrg, app.requirePermission("documents.view")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      try {
        const folders = await folderService.listFolders(deps, actorFrom(request), departmentId);
        return reply.send({ folders });
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.get(
    "/:departmentId/my-permissions",
    { preHandler: inOrg },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      const { folderId } = request.query as { folderId?: string };
      try {
        const result = await folderService.myPermissions(
          deps,
          actorFrom(request),
          departmentId,
          folderId,
        );
        return reply.send(result);
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.get(
    "/:departmentId/folders/:folderId/path",
    { preHandler: [...inOrg, app.requirePermission("documents.view")] },
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      try {
        const path = await folderService.folderPath(deps, actorFrom(request), folderId);
        return reply.send({ path });
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.post(
    "/:departmentId/folders",
    { preHandler: [...inOrg, app.requirePermission("folders.create")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      const body = createFolderSchema.parse(request.body);
      try {
        const folder = await folderService.createFolder(deps, actorFrom(request), departmentId, body);
        return reply.code(201).send({ folder });
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.patch(
    "/:departmentId/folders/:folderId",
    { preHandler: [...inOrg, app.requirePermission("folders.rename")] },
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      const body = renameFolderSchema.parse(request.body);
      try {
        const folder = await folderService.renameFolder(deps, actorFrom(request), folderId, body.name);
        return reply.send({ folder });
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.post(
    "/:departmentId/folders/:folderId/move",
    {
      preHandler: [
        ...inOrg,
        // Allowed to move the folder where it is…
        app.requirePermission("folders.move"),
        // …and where it's going (the department root when parentFolderId is null). Resolved by the
        // engine, so a confidential branch the actor isn't named on — or a folder whose override
        // withholds moves — is refused with the same 403 as anything else, never revealing it.
        app.requirePermission("folders.move", (request) => {
          const { departmentId } = request.params as { departmentId: string };
          const body = (request.body ?? {}) as { parentFolderId?: unknown };
          return {
            departmentId,
            folderId: typeof body.parentFolderId === "string" ? body.parentFolderId : undefined,
          };
        }),
      ],
    },
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      const body = moveFolderSchema.parse(request.body);
      try {
        const result = await folderService.moveFolder(
          deps,
          actorFrom(request),
          folderId,
          body.parentFolderId,
        );
        return reply.send(result);
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.delete(
    "/:departmentId/folders/:folderId",
    { preHandler: [...inOrg, app.requirePermission("folders.delete")] },
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      try {
        const result = await folderService.deleteFolder(deps, actorFrom(request), folderId);
        return reply.send(result);
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  // ── folder permission overrides (break inheritance, restrict a role) — Department Admin only ──
  app.get(
    "/:departmentId/folders/:folderId/permissions",
    { preHandler: [...inOrg, app.requirePermission("configuration.edit_rules", departmentOnlyTarget)] },
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      try {
        return reply.send(await folderService.listFolderPermissions(deps, actorFrom(request), folderId));
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.put(
    "/:departmentId/folders/:folderId/permissions/:roleId",
    { preHandler: [...inOrg, app.requirePermission("configuration.edit_rules", departmentOnlyTarget)] },
    async (request, reply) => {
      const { folderId, roleId } = request.params as { folderId: string; roleId: string };
      const body = overrideSchema.parse(request.body);
      try {
        return reply.send(
          await folderService.setFolderPermission(deps, actorFrom(request), folderId, roleId, body.restrict),
        );
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );

  app.delete(
    "/:departmentId/folders/:folderId/permissions/:roleId",
    { preHandler: [...inOrg, app.requirePermission("configuration.edit_rules", departmentOnlyTarget)] },
    async (request, reply) => {
      const { folderId, roleId } = request.params as { folderId: string; roleId: string };
      try {
        return reply.send(
          await folderService.clearFolderPermission(deps, actorFrom(request), folderId, roleId),
        );
      } catch (err) {
        return handleFolderError(err, reply);
      }
    },
  );
}
