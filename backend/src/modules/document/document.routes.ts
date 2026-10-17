import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as documentService from "./document.service.js";
import { DocumentError } from "./document.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";
import type { PermissionTarget } from "../../plugins/authenticate.js";

const fieldValuesSchema = z
  .array(
    z.object({
      fieldDefId: z.string().uuid(),
      value: z.string(),
    }),
  )
  .max(200);

const editMetadataSchema = z.object({ fieldValues: fieldValuesSchema });

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handleDocumentError(err: unknown, reply: FastifyReply) {
  if (err instanceof DocumentError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

// The folder listing carries its department + folder in the query string, so permission is
// resolved for that exact folder (honouring overrides and the confidential boundary).
const folderTargetFromQuery = (request: FastifyRequest): PermissionTarget => {
  const q = (request.query ?? {}) as Record<string, string | undefined>;
  return { departmentId: q.departmentId, folderId: q.folderId };
};

/**
 * Document routes, mounted at /documents.
 *
 * These are the operations that need **no file bytes** — reading, exact-ID lookup, restoring an
 * earlier version (which reuses the stored file), and metadata edits. The endpoints that ingest a
 * new file (first upload, upload-a-new-version) belong to Module 6, which stores the file through
 * the storage abstraction and then calls this module's `createDocument` / `addVersion`.
 *
 * Document-scoped routes resolve permission inside the service (by the document's own folder)
 * rather than via `requirePermission`, because access here is identity-based — the caller has a
 * document ID, not a folder path.
 */
export default async function documentRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  // Active documents in one folder. `documents.view`, resolved for the folder in the query.
  app.get(
    "/",
    { preHandler: [...inOrg, app.requirePermission("documents.view", folderTargetFromQuery)] },
    async (request, reply) => {
      const { folderId } = request.query as { folderId?: string };
      if (!folderId) {
        return reply.code(400).send({ error: "folder_required", message: "A folder is required." });
      }
      try {
        const documents = await documentService.listFolderDocuments(deps, actorFrom(request), folderId);
        return reply.send({ documents });
      } catch (err) {
        return handleDocumentError(err, reply);
      }
    },
  );

  // Exact-match ID lookup (DOC-3). Gated inside the service so an ID the caller may not see returns
  // the same "not found" as an unknown ID.
  app.get("/lookup", { preHandler: inOrg }, async (request, reply) => {
    const { ref } = request.query as { ref?: string };
    if (!ref) {
      return reply.code(400).send({ error: "ref_required", message: "A document ID is required." });
    }
    try {
      const result = await documentService.lookupByRef(deps, actorFrom(request), ref);
      return reply.send(result);
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  app.get("/:documentId", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      const document = await documentService.getDocument(deps, actorFrom(request), documentId);
      return reply.send({ document });
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  app.get("/:documentId/activity", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      const activity = await documentService.getDocumentActivity(deps, actorFrom(request), documentId);
      return reply.send({ activity });
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  // Serves a version's bytes for in-browser preview or download. Returns raw bytes (not JSON), with
  // the stored MIME type; the frontend fetches it as a blob so it can render it under the in-memory
  // access token (an <img>/<iframe> src can't carry the Bearer header).
  app.get("/:documentId/file", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const { versionId, download } = request.query as { versionId?: string; download?: string };
    const mode = download === "1" || download === "true" ? "download" : "preview";
    try {
      const file = await documentService.getDocumentFile(
        { prisma: opts.prisma, env: app.env },
        actorFrom(request),
        documentId,
        versionId,
        mode,
      );
      reply.header("Content-Type", file.mimeType);
      reply.header("Content-Length", file.buffer.length);
      reply.header(
        "Content-Disposition",
        `${mode === "download" ? "attachment" : "inline"}; filename="${encodeURIComponent(file.fileName)}"`,
      );
      return reply.send(file.buffer);
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  app.post(
    "/:documentId/versions/:versionId/restore",
    { preHandler: inOrg },
    async (request, reply) => {
      const { documentId, versionId } = request.params as { documentId: string; versionId: string };
      try {
        const document = await documentService.restoreVersion(
          deps,
          actorFrom(request),
          documentId,
          versionId,
        );
        return reply.send({ document });
      } catch (err) {
        return handleDocumentError(err, reply);
      }
    },
  );

  app.patch("/:documentId/metadata", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const body = editMetadataSchema.parse(request.body);
    try {
      const document = await documentService.editMetadata(
        deps,
        actorFrom(request),
        documentId,
        body.fieldValues,
      );
      return reply.send({ document });
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  // ── trash (Module 11) — document-scoped actions, permission resolved inside the service ──
  app.delete("/:documentId", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      return reply.send(await documentService.deleteDocument(deps, actorFrom(request), documentId));
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  app.post("/:documentId/restore", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      const document = await documentService.restoreDocument(deps, actorFrom(request), documentId);
      return reply.send({ document });
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });

  // Permanent deletion — Department Admin only, enforced in the service.
  app.post("/:documentId/purge", { preHandler: inOrg }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      const result = await documentService.purgeDocument(
        { prisma: opts.prisma, env: app.env },
        actorFrom(request),
        documentId,
      );
      return reply.send(result);
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });
}

/** Department-scoped trash routes, mounted under /departments so `requirePermission` finds the
 *  department. Listing/empty operate across the whole department's trash. */
export async function departmentTrashRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  app.get(
    "/:departmentId/trash",
    { preHandler: [...inOrg, app.requirePermission("documents.restore")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      try {
        const items = await documentService.listTrash(deps, actorFrom(request), departmentId);
        return reply.send({ items });
      } catch (err) {
        return handleDocumentError(err, reply);
      }
    },
  );

  app.post("/:departmentId/trash/empty", { preHandler: inOrg }, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      const result = await documentService.emptyTrash(
        { prisma: opts.prisma, env: app.env },
        actorFrom(request),
        departmentId,
      );
      return reply.send(result);
    } catch (err) {
      return handleDocumentError(err, reply);
    }
  });
}
