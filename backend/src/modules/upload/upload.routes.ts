import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import * as uploadService from "./upload.service.js";
import { UploadError } from "./upload.service.js";
import * as documentService from "../document/document.service.js";
import { DocumentError } from "../document/document.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";
import type { Env } from "../../config/env.js";
import { UploadLimiter } from "../../lib/upload-limiter.js";

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof UploadError) {
    return reply
      .code(err.statusCode)
      .send({ error: err.code, message: err.message, details: err.details });
  }
  if (err instanceof DocumentError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

const fieldValuesSchema = z
  .array(z.object({ fieldDefId: z.string().uuid(), value: z.string() }))
  .max(200);
const duplicateResolutions = ["new_version", "keep_both", "skip"] as const;

interface ParsedUpload {
  file?: { fileName: string; declaredMime?: string; data: Buffer };
  fields: Record<string, string>;
  tooLarge: boolean;
}

/**
 * Reads a single-file multipart body. Uses the async part iterator so text fields may appear in any
 * order relative to the file. `toBuffer()` respects the registered fileSize limit and throws when
 * exceeded — surfaced as a clean 413 rather than a stream error.
 */
async function parseSingleUpload(request: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let file: ParsedUpload["file"];
  let tooLarge = false;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      try {
        const data = await part.toBuffer();
        file = { fileName: part.filename, declaredMime: part.mimetype, data };
      } catch {
        tooLarge = true;
        // Drain so the iterator can finish cleanly.
        part.file.resume();
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { file, fields, tooLarge };
}

// One limiter per app (keyed on its env object, shared by both upload route plugins below).
const limiters = new WeakMap<object, UploadLimiter>();
function limiterFor(env: Env): UploadLimiter {
  let limiter = limiters.get(env);
  if (!limiter) {
    limiter = new UploadLimiter(env.MAX_CONCURRENT_UPLOADS, env.MAX_CONCURRENT_UPLOADS_PER_USER);
    limiters.set(env, limiter);
  }
  return limiter;
}

/**
 * Runs an upload handler inside a concurrency slot (SECURITY_AUDIT.md M-5), taken *before* the file
 * is read into memory and always released afterwards. No slot → 429 with Retry-After.
 */
async function withUploadSlot(
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<unknown>,
) {
  const slot = limiterFor(env).tryAcquire(request.user!.sub);
  if (!slot.ok) {
    return reply
      .code(429)
      .header("Retry-After", "5")
      .send({
        error: "upload_busy",
        message:
          slot.reason === "user_busy"
            ? "You already have uploads in progress — wait for them to finish, then try again."
            : "The server is busy with other uploads — try again in a few seconds.",
      });
  }
  try {
    return await handler();
  } finally {
    slot.release();
  }
}

function parseFieldValues(raw: string | undefined) {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UploadError(
      400,
      "invalid_field_values",
      "The metadata could not be read (invalid JSON).",
    );
  }
  const result = fieldValuesSchema.safeParse(parsed);
  if (!result.success) {
    throw new UploadError(
      400,
      "invalid_field_values",
      "The metadata was not in the expected shape.",
    );
  }
  return result.data;
}

/**
 * Folder-scoped upload + the department needs-details queue, mounted under /departments so
 * `requirePermission` resolves department and folder from the route.
 */
export async function departmentUploadRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma, env: app.env };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  app.post(
    "/:departmentId/folders/:folderId/documents/upload",
    { preHandler: [...inOrg, app.requirePermission("documents.upload")] },
    async (request, reply) =>
      withUploadSlot(deps.env, request, reply, async () => {
        const { departmentId, folderId } = request.params as {
          departmentId: string;
          folderId: string;
        };
        try {
          const { file, fields, tooLarge } = await parseSingleUpload(request);
          if (tooLarge) {
            const mb = Math.round(deps.env.MAX_UPLOAD_BYTES / (1024 * 1024));
            return reply
              .code(413)
              .send({ error: "file_too_large", message: `File is larger than the ${mb}MB limit.` });
          }
          if (!file) {
            return reply
              .code(400)
              .send({ error: "file_required", message: "No file was uploaded." });
          }
          if (!fields.documentTypeId) {
            return reply
              .code(400)
              .send({ error: "document_type_required", message: "A document type is required." });
          }
          const onDuplicate = duplicateResolutions.includes(fields.onDuplicate as never)
            ? (fields.onDuplicate as (typeof duplicateResolutions)[number])
            : undefined;

          const result = await uploadService.uploadDocument(deps, actorFrom(request), {
            departmentId,
            folderId,
            documentTypeId: fields.documentTypeId,
            fieldValues: parseFieldValues(fields.fieldValues),
            file,
            changeNote: fields.changeNote ?? null,
            onDuplicate,
            duplicateOfDocumentId: fields.duplicateOfDocumentId || undefined,
          });
          return reply
            .code(result.action === "created" || result.action === "new_version" ? 201 : 200)
            .send(result);
        } catch (err) {
          return handleError(err, reply);
        }
      }),
  );

  // The "needs details" queue (UPL-5): documents saved incomplete, missing a required field value.
  app.get(
    "/:departmentId/documents/needs-details",
    { preHandler: [...inOrg, app.requirePermission("documents.view")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      try {
        const documents = await documentService.listNeedsDetails(
          deps,
          actorFrom(request),
          departmentId,
        );
        return reply.send({ documents });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}

/**
 * Upload a new version of an existing document, by document identity (permission checked in the
 * service against the document's own folder). Mounted under /documents.
 */
export async function documentUploadRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma, env: app.env };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  app.post("/:documentId/versions/upload", { preHandler: inOrg }, async (request, reply) =>
    withUploadSlot(deps.env, request, reply, async () => {
      const { documentId } = request.params as { documentId: string };
      try {
        const { file, fields, tooLarge } = await parseSingleUpload(request);
        if (tooLarge) {
          const mb = Math.round(deps.env.MAX_UPLOAD_BYTES / (1024 * 1024));
          return reply
            .code(413)
            .send({ error: "file_too_large", message: `File is larger than the ${mb}MB limit.` });
        }
        if (!file) {
          return reply.code(400).send({ error: "file_required", message: "No file was uploaded." });
        }
        const result = await uploadService.uploadNewVersion(
          deps,
          actorFrom(request),
          documentId,
          file,
          fields.changeNote ?? null,
        );
        return reply.code(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    }),
  );
}
