import fp from "fastify-plugin";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import { verifyAccessToken, type AccessTokenPayload } from "../lib/jwt.js";
import {
  resolveEffectivePermissions,
  type EffectivePermissions,
} from "../lib/effective-permissions.js";
import type { PermissionKey } from "../lib/permissions.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AccessTokenPayload;
    /** Set by `requirePermission` so handlers can reuse the resolution instead of redoing it. */
    effectivePermissions?: EffectivePermissions;
  }
}

export default fp(async function authenticatePlugin(app: FastifyInstance) {
  const env = app.env as Env;

  app.decorateRequest("user", undefined);
  app.decorateRequest("effectivePermissions", undefined);

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing access token" });
    }
    const token = header.slice("Bearer ".length);
    try {
      request.user = verifyAccessToken(env, token);
    } catch {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid or expired token" });
    }
  });

  app.decorate("requireVerifiedEmail", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user?.emailVerified) {
      return reply
        .code(403)
        .send({ error: "email_not_verified", message: "Verify your email to continue" });
    }
  });

  app.decorate("requireOrganization", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user?.organizationId) {
      return reply
        .code(400)
        .send({ error: "no_organization_selected", message: "Select an organization first" });
    }
  });

  app.decorate("requireSuperAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user?.isSuperAdmin) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Only the Super Admin can do this." });
    }
  });

  // One-line permission gate for every protected route: `preHandler: [app.authenticate,
  // app.requireOrganization, app.requirePermission("documents.upload")]`. Routes must never
  // hand-roll their own check — the resolution order (role baseline → folder override restricts
  // → confidential named-list, Super Admin excluded) lives in exactly one place.
  app.decorate(
    "requirePermission",
    (key: PermissionKey, extract: PermissionTargetExtractor = defaultTarget) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const user = request.user;
        if (!user?.organizationId) {
          return reply
            .code(400)
            .send({ error: "no_organization_selected", message: "Select an organization first" });
        }

        const target = extract(request);
        if (!target.departmentId) {
          return reply
            .code(400)
            .send({ error: "department_required", message: "This action needs a department." });
        }

        const actor = {
          userId: user.sub,
          organizationId: user.organizationId,
          isSuperAdmin: user.isSuperAdmin === true,
        };
        const resolved = await resolveEffectivePermissions(
          app.prisma,
          actor,
          target.departmentId,
          target.folderId,
        );

        if (resolved.permissions[key] !== true) {
          // Deliberately the same response whether the actor lacks the permission, isn't a member,
          // or is looking at a confidential folder they're not named on — a confidential folder is
          // "invisible entirely" (Feature Spec §11), so a distinct error would leak its existence.
          return reply.code(403).send({ error: "forbidden", message: "You don't have access to this." });
        }

        // Cached on the request so a handler can shape its response to what the caller may do
        // (e.g. a read-only toolbar) without resolving a second time.
        request.effectivePermissions = resolved;
      },
  );
});

export interface PermissionTarget {
  departmentId?: string;
  folderId?: string | null;
}

export type PermissionTargetExtractor = (request: FastifyRequest) => PermissionTarget;

const defaultTarget: PermissionTargetExtractor = (request) => {
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  return {
    departmentId: params.departmentId ?? (typeof body.departmentId === "string" ? body.departmentId : undefined),
    folderId: params.folderId ?? (typeof body.folderId === "string" ? body.folderId : undefined),
  };
};

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    prisma: PrismaClient;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireVerifiedEmail: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOrganization: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireSuperAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      key: PermissionKey,
      extract?: PermissionTargetExtractor,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
