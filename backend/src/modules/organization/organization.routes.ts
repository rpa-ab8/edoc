import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { updateOrganizationSchema } from "./organization.schemas.js";
import * as orgService from "./organization.service.js";
import { OrganizationError } from "./organization.service.js";
import { listInvitations } from "../invitation/invitation.service.js";

function handleOrgError(err: unknown, reply: FastifyReply) {
  if (err instanceof OrganizationError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

export default async function organizationRoutes(
  app: FastifyInstance,
  opts: { prisma: PrismaClient; redis: Redis },
) {
  const deps = { prisma: opts.prisma, redis: opts.redis, env: app.env };

  app.get(
    "/current",
    { preHandler: [app.authenticate, app.requireOrganization] },
    async (request, reply) => {
      const organization = await orgService.getOrganization(deps, request.user!.organizationId!);
      return reply.send({ organization });
    },
  );

  app.patch(
    "/current",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const body = updateOrganizationSchema.parse(request.body);
      try {
        const organization = await orgService.updateOrganization(
          deps,
          request.user!.organizationId!,
          request.user!.sub,
          body,
        );
        return reply.send({ organization });
      } catch (err) {
        return handleOrgError(err, reply);
      }
    },
  );

  app.get(
    "/current/dashboard",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const dashboard = await orgService.getDashboard(deps, request.user!.organizationId!);
      return reply.send(dashboard);
    },
  );

  app.get(
    "/current/members",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const members = await orgService.listMembers(deps, request.user!.organizationId!);
      return reply.send({ members });
    },
  );

  // A minimal org-wide user list (id/name/email) any member can read — backs the share recipient
  // picker (bug 1). Not Super-Admin-gated, unlike the full member directory above.
  app.get(
    "/current/users",
    { preHandler: [app.authenticate, app.requireVerifiedEmail, app.requireOrganization] },
    async (request, reply) => {
      const users = await orgService.listOrgUsers(deps, request.user!.organizationId!);
      return reply.send({ users });
    },
  );

  // Org-wide view of what is still outstanding, for the user directory. Super-Admin-only, since
  // the directory itself is; per-department invite management lives under /departments.
  app.get(
    "/current/invitations",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const invitations = await listInvitations(
        { prisma: opts.prisma, redis: opts.redis, env: app.env },
        request.user!.organizationId!,
      );
      return reply.send({ invitations });
    },
  );

  app.patch(
    "/current/members/:userId/disable",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      try {
        const result = await orgService.setMemberEnabled(
          deps,
          request.user!.organizationId!,
          request.user!.sub,
          userId,
          false,
        );
        return reply.send(result);
      } catch (err) {
        return handleOrgError(err, reply);
      }
    },
  );

  app.patch(
    "/current/members/:userId/enable",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      try {
        const result = await orgService.setMemberEnabled(
          deps,
          request.user!.organizationId!,
          request.user!.sub,
          userId,
          true,
        );
        return reply.send(result);
      } catch (err) {
        return handleOrgError(err, reply);
      }
    },
  );

  app.post(
    "/current/members/:userId/reset-password",
    { preHandler: [app.authenticate, app.requireOrganization, app.requireSuperAdmin] },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      try {
        const result = await orgService.resetMemberPassword(
          deps,
          request.user!.organizationId!,
          request.user!.sub,
          userId,
        );
        return reply.send(result);
      } catch (err) {
        return handleOrgError(err, reply);
      }
    },
  );
}
