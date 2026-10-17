import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as sharingService from "./sharing.service.js";
import { SharingError } from "./sharing.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";

const permissionSchema = z.enum(["view", "download"]);

const createShareSchema = z
  .object({
    targetType: z.enum(["user", "department", "external_link"]),
    targetUserId: z.string().uuid().optional(),
    targetDepartmentId: z.string().uuid().optional(),
    permission: permissionSchema.default("view"),
    expiresInDays: z.number().int().positive().max(365).nullable().optional(),
  })
  .refine((v) => v.targetType !== "user" || !!v.targetUserId, {
    message: "A recipient user is required.",
    path: ["targetUserId"],
  })
  .refine((v) => v.targetType !== "department" || !!v.targetDepartmentId, {
    message: "A recipient department is required.",
    path: ["targetDepartmentId"],
  });

const updateShareSchema = z
  .object({
    permission: permissionSchema.optional(),
    expiresInDays: z.number().int().positive().max(365).nullable().optional(),
  })
  .refine((v) => v.permission !== undefined || v.expiresInDays !== undefined, {
    message: "Nothing to update.",
  });

const respondSchema = z.object({ accept: z.boolean() });

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handleSharingError(err: unknown, reply: FastifyReply) {
  if (err instanceof SharingError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Authenticated sharing routes. Split across three mount points so each lands where the permission
 * engine (or ownership) can gate it:
 *   - document-scoped (`/documents/:documentId/shares`): create + list, gated inside the service by
 *     the caller's resolved permission on the document's own folder;
 *   - user-scoped (`/shares/...`): the caller's own inbox/outbox and control of their own shares;
 *   - department-scoped (`/departments/:departmentId/shares/...`): inbound cross-department consent,
 *     gated by `sharing.cross_department_share` on the receiving department.
 */
export async function sharingRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const fileDeps = { prisma: opts.prisma, env: app.env };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  // ── document-scoped: create + list shares on a document ──
  app.post("/documents/:documentId/shares", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const body = createShareSchema.parse(request.body);
    try {
      const result = await sharingService.createShare(deps, actorFrom(request), documentId, body);
      const linkUrl = result.linkToken ? `${app.env.FRONTEND_URL}/l/${result.linkToken}` : undefined;
      return reply.code(201).send({ share: result.share, ...(linkUrl ? { linkUrl } : {}) });
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });

  app.get("/documents/:documentId/shares", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      const shares = await sharingService.listDocumentShares(deps, actorFrom(request), documentId);
      return reply.send({ shares });
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });

  // ── user-scoped: my inbox / outbox and control of my own shares ──
  app.get("/shares/with-me", { preHandler: inOrg }, async (request, reply) => {
    const shares = await sharingService.listSharedWithMe(deps, actorFrom(request));
    return reply.send({ shares });
  });

  app.get("/shares/by-me", { preHandler: inOrg }, async (request, reply) => {
    const shares = await sharingService.listSharedByMe(deps, actorFrom(request));
    return reply.send({ shares });
  });

  app.patch("/shares/:shareId", { preHandler: inOrg }, async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const body = updateShareSchema.parse(request.body);
    try {
      const share = await sharingService.updateShare(deps, actorFrom(request), shareId, body);
      return reply.send({ share });
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });

  app.delete("/shares/:shareId", { preHandler: inOrg }, async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    try {
      const result = await sharingService.revokeShare(deps, actorFrom(request), shareId);
      return reply.send(result);
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });

  // The recipient's tidy-up: remove a share from *my* "Shared with me" without revoking it.
  app.post("/shares/:shareId/dismiss", { preHandler: inOrg }, async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    try {
      const result = await sharingService.dismissShare(deps, actorFrom(request), shareId);
      return reply.send(result);
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });

  // ── department-scoped: inbound cross-department consent (SHR-3) ──
  app.get(
    "/departments/:departmentId/shares/pending",
    { preHandler: [...inOrg, app.requirePermission("sharing.cross_department_share")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      const shares = await sharingService.listPendingForDepartment(deps, actorFrom(request), departmentId);
      return reply.send({ shares });
    },
  );

  app.post(
    "/departments/:departmentId/shares/:shareId/respond",
    { preHandler: [...inOrg, app.requirePermission("sharing.cross_department_share")] },
    async (request, reply) => {
      const { departmentId, shareId } = request.params as { departmentId: string; shareId: string };
      const { accept } = respondSchema.parse(request.body);
      try {
        const result = await sharingService.respondToCrossDepartmentShare(
          deps,
          actorFrom(request),
          departmentId,
          shareId,
          accept,
        );
        return reply.send(result);
      } catch (err) {
        return handleSharingError(err, reply);
      }
    },
  );

  // ── public: an external-link holder has a token, not an account or a session ──
  app.get("/links/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const doc = await sharingService.openLink(deps, token);
      return reply.send({ document: doc });
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });

  app.get("/links/:token/file", async (request, reply) => {
    const { token } = request.params as { token: string };
    const { download } = request.query as { download?: string };
    const mode = download === "1" || download === "true" ? "download" : "preview";
    try {
      const file = await sharingService.fetchLinkFile(fileDeps, token, mode);
      reply.header("Content-Type", file.mimeType);
      reply.header("Content-Length", file.buffer.length);
      reply.header(
        "Content-Disposition",
        `${mode === "download" ? "attachment" : "inline"}; filename="${encodeURIComponent(file.fileName)}"`,
      );
      return reply.send(file.buffer);
    } catch (err) {
      return handleSharingError(err, reply);
    }
  });
}
