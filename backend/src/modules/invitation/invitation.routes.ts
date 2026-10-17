import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { z } from "zod";
import * as invitationService from "./invitation.service.js";
import { InvitationError } from "./invitation.service.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";
import { REFRESH_COOKIE_NAME } from "../auth/auth.service.js";
import { verifyAccessToken } from "../../lib/jwt.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";

const createInvitationSchema = z.object({
  email: z.string().trim().email(),
  roleId: z.string().uuid(),
});

const acceptInvitationSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).optional(),
});

function actorFrom(request: FastifyRequest): PermissionActor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handleInvitationError(err: unknown, reply: FastifyReply) {
  if (err instanceof InvitationError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

/** Management routes — mounted under /departments so `requirePermission` finds the department. */
export async function departmentInvitationRoutes(
  app: FastifyInstance,
  opts: { prisma: PrismaClient; redis: Redis },
) {
  const deps = { prisma: opts.prisma, redis: opts.redis, env: app.env };
  const inOrg = [app.authenticate, app.requireVerifiedEmail, app.requireOrganization];

  app.get(
    "/:departmentId/invitations",
    { preHandler: [...inOrg, app.requirePermission("members.invite")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      const invitations = await invitationService.listInvitations(
        deps,
        request.user!.organizationId!,
        departmentId,
      );
      return reply.send({ invitations });
    },
  );

  app.post(
    "/:departmentId/invitations",
    { preHandler: [...inOrg, app.requirePermission("members.invite")] },
    async (request, reply) => {
      const { departmentId } = request.params as { departmentId: string };
      const body = createInvitationSchema.parse(request.body);
      try {
        const invitation = await invitationService.createInvitation(
          deps,
          actorFrom(request),
          departmentId,
          body,
        );
        return reply.code(201).send({ invitation });
      } catch (err) {
        return handleInvitationError(err, reply);
      }
    },
  );

  app.post(
    "/:departmentId/invitations/:invitationId/resend",
    { preHandler: [...inOrg, app.requirePermission("members.invite")] },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      try {
        const result = await invitationService.resendInvitation(deps, actorFrom(request), invitationId);
        return reply.send(result);
      } catch (err) {
        return handleInvitationError(err, reply);
      }
    },
  );

  app.delete(
    "/:departmentId/invitations/:invitationId",
    { preHandler: [...inOrg, app.requirePermission("members.invite")] },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      try {
        const result = await invitationService.revokeInvitation(deps, actorFrom(request), invitationId);
        return reply.send(result);
      } catch (err) {
        return handleInvitationError(err, reply);
      }
    },
  );
}

/** Public routes — the recipient has a token, not an account or a session. */
export async function publicInvitationRoutes(
  app: FastifyInstance,
  opts: { prisma: PrismaClient; redis: Redis },
) {
  const deps = { prisma: opts.prisma, redis: opts.redis, env: app.env };

  app.get("/:token", { config: { rateLimit: RATE_LIMITS.publicRead } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const invitation = await invitationService.previewInvitation(deps, token);
      return reply.send({ invitation });
    } catch (err) {
      return handleInvitationError(err, reply);
    }
  });

  // Optional authentication: an existing account must be signed in to accept, but a brand-new
  // recipient has no session yet — so this route reads a token if one is present and doesn't
  // require it.
  app.post("/:token/accept", { config: { rateLimit: RATE_LIMITS.sensitive } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = acceptInvitationSchema.parse(request.body ?? {});

    let authenticatedUserId: string | undefined;
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        authenticatedUserId = verifyAccessToken(app.env, header.slice("Bearer ".length)).sub;
      } catch {
        authenticatedUserId = undefined;
      }
    }

    try {
      const result = await invitationService.acceptInvitation(deps, token, body, authenticatedUserId, {
        deviceInfo: request.headers["user-agent"],
        ipAddress: request.ip,
      });

      if (result.session) {
        reply.setCookie(
          REFRESH_COOKIE_NAME,
          result.session.refreshCookie.value,
          result.session.refreshCookie.options,
        );
        return reply.send({
          organizationId: result.organizationId,
          departmentId: result.departmentId,
          createdAccount: result.createdAccount,
          accessToken: result.session.accessToken,
        });
      }

      return reply.send({
        organizationId: result.organizationId,
        departmentId: result.departmentId,
        createdAccount: result.createdAccount,
      });
    } catch (err) {
      return handleInvitationError(err, reply);
    }
  });
}
