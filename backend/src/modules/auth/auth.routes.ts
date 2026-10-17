import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import {
  createOrganizationSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  selectOrganizationSchema,
  verifyEmailSchema,
} from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import { AuthError } from "./auth.service.js";
import { REFRESH_COOKIE_NAME } from "./auth.service.js";
import type { FastifyReply, FastifyRequest } from "fastify";

function requestContext(request: FastifyRequest) {
  return {
    deviceInfo: request.headers["user-agent"],
    ipAddress: request.ip,
  };
}

function handleAuthError(err: unknown, reply: FastifyReply) {
  if (err instanceof AuthError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

export default async function authRoutes(
  app: FastifyInstance,
  opts: { prisma: PrismaClient; redis: Redis },
) {
  const deps = { prisma: opts.prisma, redis: opts.redis, env: app.env };

  app.get("/signup-mode", async (_request, reply) => {
    const setting = await opts.prisma.signupSetting.findUnique({ where: { id: 1 } });
    return reply.send({ mode: setting?.mode ?? "invite_code" });
  });

  app.post("/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    try {
      const result = await authService.register(deps, body, requestContext(request));
      reply.setCookie(REFRESH_COOKIE_NAME, result.refreshCookie.value, result.refreshCookie.options);
      return reply.code(201).send({ user: result.user, accessToken: result.accessToken });
    } catch (err) {
      return handleAuthError(err, reply);
    }
  });

  app.post("/verify-email", async (request, reply) => {
    const body = verifyEmailSchema.parse(request.body);
    try {
      await authService.verifyEmail(deps, body.token);
      return reply.send({ verified: true });
    } catch (err) {
      return handleAuthError(err, reply);
    }
  });

  app.post(
    "/resend-verification",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        await authService.resendVerification(deps, request.user!.sub);
        return reply.send({ sent: true });
      } catch (err) {
        return handleAuthError(err, reply);
      }
    },
  );

  app.post("/organizations", { preHandler: app.authenticate }, async (request, reply) => {
    const body = createOrganizationSchema.parse(request.body);
    try {
      const result = await authService.createOrganization(deps, request.user!.sub, body);
      return reply.code(201).send({ organization: result.organization, accessToken: result.accessToken });
    } catch (err) {
      return handleAuthError(err, reply);
    }
  });

  app.post("/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    try {
      const result = await authService.login(deps, body, requestContext(request));
      reply.setCookie(REFRESH_COOKIE_NAME, result.refreshCookie.value, result.refreshCookie.options);
      return reply.send({
        user: result.user,
        organizations: result.organizations,
        autoSelectedOrganizationId: result.autoSelectedOrganizationId,
        accessToken: result.accessToken,
      });
    } catch (err) {
      return handleAuthError(err, reply);
    }
  });

  app.post(
    "/select-organization",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = selectOrganizationSchema.parse(request.body);
      try {
        const result = await authService.selectOrganization(
          deps,
          request.user!.sub,
          body.organizationId,
        );
        return reply.send({ accessToken: result.accessToken });
      } catch (err) {
        return handleAuthError(err, reply);
      }
    },
  );

  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await authService.me(deps, request.user!.sub);
    return reply.send(result);
  });

  app.post("/refresh", async (request, reply) => {
    const rawToken = request.cookies[REFRESH_COOKIE_NAME];
    if (!rawToken) {
      return reply.code(401).send({ error: "unauthorized", message: "No refresh token" });
    }
    const body = refreshSchema.parse(request.body ?? {});
    try {
      const result = await authService.refresh(deps, rawToken, {
        ...requestContext(request),
        organizationId: body.organizationId,
      });
      reply.setCookie(REFRESH_COOKIE_NAME, result.refreshCookie.value, result.refreshCookie.options);
      return reply.send({ accessToken: result.accessToken });
    } catch (err) {
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
      return handleAuthError(err, reply);
    }
  });

  app.post("/logout", async (request, reply) => {
    const rawToken = request.cookies[REFRESH_COOKIE_NAME];
    await authService.logout(deps, rawToken);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.post(
    "/logout-all",
    { preHandler: app.authenticate },
    async (request, reply) => {
      await authService.logoutAll(deps, request.user!.sub);
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
      return reply.code(204).send();
    },
  );

  app.post("/forgot-password", async (request, reply) => {
    const body = forgotPasswordSchema.parse(request.body);
    await authService.forgotPassword(deps, body.email);
    return reply.send({
      message: "If an account exists for that email, a reset link has been sent.",
    });
  });

  app.post("/reset-password", async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);
    try {
      await authService.resetPassword(deps, body.token, body.newPassword);
      return reply.send({ reset: true });
    } catch (err) {
      return handleAuthError(err, reply);
    }
  });
}
