import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Env } from "./config/env.js";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import authenticatePlugin from "./plugins/authenticate.js";
import authRoutes from "./modules/auth/auth.routes.js";
import { AuthError } from "./modules/auth/auth.service.js";
import storageRoutes from "./modules/storage/storage.routes.js";
import { StorageConfigError } from "./modules/storage/storage.service.js";
import organizationRoutes from "./modules/organization/organization.routes.js";
import { OrganizationError } from "./modules/organization/organization.service.js";
import departmentRoutes from "./modules/department/department.routes.js";
import {
  departmentInvitationRoutes,
  publicInvitationRoutes,
} from "./modules/invitation/invitation.routes.js";
import { InvitationError } from "./modules/invitation/invitation.service.js";
import folderRoutes from "./modules/folder/folder.routes.js";
import { FolderError } from "./modules/folder/folder.service.js";
import documentRoutes, { departmentTrashRoutes } from "./modules/document/document.routes.js";
import { DocumentError } from "./modules/document/document.service.js";
import searchRoutes from "./modules/search/search.routes.js";
import {
  departmentUploadRoutes,
  documentUploadRoutes,
} from "./modules/upload/upload.routes.js";
import { UploadError } from "./modules/upload/upload.service.js";
import { DepartmentError } from "./modules/department/department.service.js";
import { sharingRoutes } from "./modules/sharing/sharing.routes.js";
import { SharingError } from "./modules/sharing/sharing.service.js";
import { confidentialRoutes } from "./modules/confidential/confidential.routes.js";
import { ConfidentialError } from "./modules/confidential/confidential.service.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { AuditError } from "./modules/audit/audit.service.js";

export function buildApp(env: Env, prisma: PrismaClient, redis: Redis): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
    // Behind Caddy in production: request.ip comes from X-Forwarded-For, which Caddy sanitises.
    trustProxy: env.TRUST_PROXY,
  });

  app.decorate("env", env);
  // Decorated on the instance so cross-cutting plugins (the permission engine's
  // `requirePermission` gate) can query without every route passing prisma in by hand.
  app.decorate("prisma", prisma);

  app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });
  app.register(cookie);
  // Opt-in per route (see lib/rate-limits.ts) — no global limit, since an office shares one IP.
  // Registered before every route plugin so its onRoute hook sees their `config.rateLimit`.
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: "rate_limited",
      message: `Too many attempts. Try again in ${context.after}.`,
    }),
  });
  // File uploads (Module 6). fileSize is the hard byte ceiling — a larger file trips the limit and
  // is surfaced as a clean 413 rather than being partially stored. One file per request (bulk is
  // many independent requests); a handful of accompanying text fields (metadata, duplicate choice).
  app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 25 },
  });
  app.register(authenticatePlugin);
  app.register(authRoutes, { prisma, redis, prefix: "/auth" });
  app.register(storageRoutes, { prisma, prefix: "/storage" });
  app.register(organizationRoutes, { prisma, redis, prefix: "/organizations" });
  app.register(departmentRoutes, { prisma, prefix: "/departments" });
  app.register(departmentInvitationRoutes, { prisma, redis, prefix: "/departments" });
  app.register(publicInvitationRoutes, { prisma, redis, prefix: "/invitations" });
  app.register(folderRoutes, { prisma, prefix: "/departments" });
  app.register(documentRoutes, { prisma, prefix: "/documents" });
  app.register(departmentTrashRoutes, { prisma, prefix: "/departments" });
  app.register(departmentUploadRoutes, { prisma, prefix: "/departments" });
  app.register(documentUploadRoutes, { prisma, prefix: "/documents" });
  app.register(searchRoutes, { prisma, prefix: "/departments" });
  // Sharing spans several path spaces (/documents, /shares, /departments, /links), so it mounts at
  // the root and carries the full paths itself rather than a single prefix.
  app.register(sharingRoutes, { prisma });
  // Confidential folders (Module 10): member management (/folders/...) + dual-control recovery
  // (/departments/...). Mounts at root and carries its own full paths.
  app.register(confidentialRoutes, { prisma });
  app.register(auditRoutes, { prisma, prefix: "/departments" });

  // Polled every 15s by the container healthcheck (and by uptime monitoring) — not worth a log line.
  app.get("/health", { logLevel: "warn" }, async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Invalid request",
        details: err.flatten().fieldErrors,
      });
    }
    if (
      err instanceof AuthError ||
      err instanceof StorageConfigError ||
      err instanceof OrganizationError ||
      err instanceof DepartmentError ||
      err instanceof InvitationError ||
      err instanceof FolderError ||
      err instanceof DocumentError ||
      err instanceof UploadError ||
      err instanceof SharingError ||
      err instanceof ConfidentialError ||
      err instanceof AuditError
    ) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    // Fastify's own request-parsing errors (bad JSON, wrong content-type, payload too large,
    // etc.) already carry the correct client-error status code — surface it instead of
    // flattening every non-domain error to a 500, which hid the real 4xx behind "internal_error".
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply
        .code(fastifyErr.statusCode)
        .send({ error: fastifyErr.code ?? "bad_request", message: fastifyErr.message ?? "Bad request" });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  return app;
}
