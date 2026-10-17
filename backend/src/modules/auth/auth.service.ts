import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Env } from "../../config/env.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { hashToken, issueToken } from "../../lib/tokens.js";
import { signAccessToken } from "../../lib/jwt.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../lib/mailer.js";
import { logAuditEvent } from "../../lib/audit.js";

export class AuthError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  prisma: PrismaClient;
  redis: Redis;
  env: Env;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  isSuperAdmin: boolean;
}

async function getUserOrganizations(
  prisma: PrismaClient,
  userId: string,
): Promise<OrganizationSummary[]> {
  const [owned, memberships] = await Promise.all([
    prisma.organization.findMany({ where: { createdByUserId: userId } }),
    prisma.membership.findMany({
      where: { userId, status: "active" },
      include: { organization: true },
    }),
  ]);

  const byId = new Map<string, OrganizationSummary>();
  for (const org of owned) {
    byId.set(org.id, { id: org.id, name: org.name, isSuperAdmin: true });
  }
  for (const m of memberships) {
    if (!byId.has(m.organization.id)) {
      byId.set(m.organization.id, {
        id: m.organization.id,
        name: m.organization.name,
        isSuperAdmin: false,
      });
    }
  }
  return [...byId.values()];
}

async function assertUserBelongsToOrganization(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (org?.createdByUserId === userId) return true;
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId, status: "active" },
  });
  return membership !== null;
}

// Exported so the invitation-accept flow can hand a brand-new user a session without
// duplicating the cookie/refresh-token rules that live here.
export function refreshCookieOptions(env: Env, maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export const REFRESH_COOKIE_NAME = "dms_refresh";

export async function issueRefreshToken(
  { prisma, env }: Deps,
  userId: string,
  deviceInfo: string | undefined,
  ipAddress: string | undefined,
) {
  const { raw, hash } = issueToken();
  const ttlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hash,
      deviceInfo,
      ipAddress,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return { raw, ttlMs };
}

export async function register(
  deps: Deps,
  input: { fullName: string; email: string; password: string },
  context: { deviceInfo?: string; ipAddress?: string },
) {
  const { prisma, env } = deps;

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AuthError(
      409,
      "email_already_registered",
      "An account with this email already exists — sign in instead.",
    );
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash, fullName: input.fullName },
  });

  const { raw } = issueToken();
  const hash = hashToken(raw);
  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000),
    },
  });
  await sendVerificationEmail(env, user.email, `${env.FRONTEND_URL}/verify-email?token=${raw}`);

  const { raw: refreshRaw, ttlMs } = await issueRefreshToken(
    deps,
    user.id,
    context.deviceInfo,
    context.ipAddress,
  );
  const accessToken = signAccessToken(env, { sub: user.id, emailVerified: false });

  return {
    user: { id: user.id, email: user.email, fullName: user.fullName, emailVerified: false },
    accessToken,
    refreshCookie: { value: refreshRaw, options: refreshCookieOptions(env, ttlMs) },
  };
}

export async function verifyEmail(deps: Deps, token: string) {
  const { prisma } = deps;
  const hash = hashToken(token);
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AuthError(
      400,
      "invalid_token",
      "This verification link is invalid or has expired.",
    );
  }
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
}

export async function resendVerification(deps: Deps, userId: string) {
  const { prisma, env } = deps;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) {
    throw new AuthError(400, "already_verified", "This account is already verified.");
  }

  await prisma.emailVerificationToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  const { raw } = issueToken();
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000),
    },
  });
  await sendVerificationEmail(env, user.email, `${env.FRONTEND_URL}/verify-email?token=${raw}`);
}

export async function createOrganization(
  deps: Deps,
  userId: string,
  input: { name: string; industry?: string; inviteCode?: string },
) {
  const { prisma, env } = deps;

  const setting = await prisma.signupSetting.findUnique({ where: { id: 1 } });
  const mode = setting?.mode ?? "invite_code";

  if (mode === "disabled") {
    throw new AuthError(
      403,
      "signup_disabled",
      "Organization creation is currently disabled.",
    );
  }

  if (mode === "invite_code") {
    if (!input.inviteCode) {
      throw new AuthError(400, "invite_code_required", "An invite code is required.");
    }
    const code = await prisma.signupInviteCode.findUnique({ where: { code: input.inviteCode } });
    const valid =
      code !== null &&
      code.active &&
      (code.expiresAt === null || code.expiresAt > new Date()) &&
      (code.maxUses === null || code.usedCount < code.maxUses);
    if (!valid || code === null) {
      throw new AuthError(
        400,
        "invalid_invite_code",
        "Invalid or already-used invite code.",
      );
    }
    await prisma.signupInviteCode.update({
      where: { id: code.id },
      data: { usedCount: { increment: 1 } },
    });
  }

  const organization = await prisma.organization.create({
    data: { name: input.name, industry: input.industry, createdByUserId: userId },
  });

  await logAuditEvent(prisma, {
    organizationId: organization.id,
    actorUserId: userId,
    action: "config_change",
    targetDescription: "Organization created",
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const accessToken = signAccessToken(env, {
    sub: userId,
    emailVerified: user.emailVerifiedAt !== null,
    organizationId: organization.id,
    isSuperAdmin: true,
  });

  return { organization, accessToken };
}

export async function login(
  deps: Deps,
  input: { email: string; password: string },
  context: { deviceInfo?: string; ipAddress?: string },
) {
  const { prisma, redis, env } = deps;
  const lockKey = `login:lock:${input.email}`;
  const failKey = `login:fail:${input.email}`;

  const locked = await redis.get(lockKey);
  if (locked) {
    throw new AuthError(
      429,
      "too_many_attempts",
      `Too many failed attempts. Try again in ${env.LOGIN_LOCKOUT_MINUTES} minutes.`,
    );
  }

  const recordFailure = async () => {
    const attempts = await redis.incr(failKey);
    await redis.expire(failKey, env.LOGIN_LOCKOUT_MINUTES * 60);
    if (attempts >= env.LOGIN_MAX_ATTEMPTS) {
      await redis.set(lockKey, "1", "EX", env.LOGIN_LOCKOUT_MINUTES * 60);
    }
    await prisma.loginAttempt.create({
      data: { email: input.email, ipAddress: context.ipAddress, succeeded: false },
    });
  };

  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    await recordFailure();
    throw new AuthError(401, "invalid_credentials", "Invalid email or password.");
  }
  if (user.status === "disabled") {
    throw new AuthError(403, "account_disabled", "This account has been disabled.");
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    await recordFailure();
    throw new AuthError(401, "invalid_credentials", "Invalid email or password.");
  }

  await redis.del(failKey, lockKey);
  await prisma.loginAttempt.create({
    data: { email: input.email, ipAddress: context.ipAddress, succeeded: true, userId: user.id },
  });

  const organizations = await getUserOrganizations(prisma, user.id);
  const autoSelected = organizations.length === 1 ? organizations[0] : undefined;

  const { raw: refreshRaw, ttlMs } = await issueRefreshToken(
    deps,
    user.id,
    context.deviceInfo,
    context.ipAddress,
  );
  const accessToken = signAccessToken(env, {
    sub: user.id,
    emailVerified: user.emailVerifiedAt !== null,
    organizationId: autoSelected?.id,
    isSuperAdmin: autoSelected?.isSuperAdmin,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerified: user.emailVerifiedAt !== null,
    },
    organizations,
    autoSelectedOrganizationId: autoSelected?.id,
    accessToken,
    refreshCookie: { value: refreshRaw, options: refreshCookieOptions(env, ttlMs) },
  };
}

export async function selectOrganization(deps: Deps, userId: string, organizationId: string) {
  const { prisma, env } = deps;
  const belongs = await assertUserBelongsToOrganization(prisma, userId, organizationId);
  if (!belongs) {
    throw new AuthError(403, "not_a_member", "You do not belong to this organization.");
  }
  const [user, organization] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  const accessToken = signAccessToken(env, {
    sub: userId,
    emailVerified: user.emailVerifiedAt !== null,
    organizationId,
    isSuperAdmin: organization.createdByUserId === userId,
  });
  return { accessToken };
}

export async function me(deps: Deps, userId: string) {
  const { prisma } = deps;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const organizations = await getUserOrganizations(prisma, userId);
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerified: user.emailVerifiedAt !== null,
    },
    organizations,
  };
}

export async function refresh(
  deps: Deps,
  rawToken: string,
  context: { deviceInfo?: string; ipAddress?: string; organizationId?: string },
) {
  const { prisma, env } = deps;
  const hash = hashToken(rawToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    throw new AuthError(401, "invalid_refresh_token", "Session expired, please sign in again.");
  }

  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date(), lastUsedAt: new Date() },
  });

  const { raw: newRaw, ttlMs } = await issueRefreshToken(
    deps,
    record.userId,
    context.deviceInfo,
    context.ipAddress,
  );

  const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });

  let organizationId: string | undefined;
  let isSuperAdmin: boolean | undefined;
  if (context.organizationId) {
    const belongs = await assertUserBelongsToOrganization(
      prisma,
      record.userId,
      context.organizationId,
    );
    if (belongs) {
      organizationId = context.organizationId;
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: context.organizationId },
      });
      isSuperAdmin = org.createdByUserId === record.userId;
    }
  }

  const accessToken = signAccessToken(env, {
    sub: record.userId,
    emailVerified: user.emailVerifiedAt !== null,
    organizationId,
    isSuperAdmin,
  });

  return {
    accessToken,
    refreshCookie: { value: newRaw, options: refreshCookieOptions(env, ttlMs) },
  };
}

export async function logout(deps: Deps, rawToken: string | undefined) {
  const { prisma } = deps;
  if (!rawToken) return;
  const hash = hashToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAll(deps: Deps, userId: string) {
  const { prisma } = deps;
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function forgotPassword(deps: Deps, email: string) {
  const { prisma, env } = deps;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Deliberately silent — do not reveal whether the email exists.
    return;
  }

  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const { raw } = issueToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
    },
  });
  await sendPasswordResetEmail(env, user.email, `${env.FRONTEND_URL}/reset-password?token=${raw}`);
}

export async function resetPassword(deps: Deps, token: string, newPassword: string) {
  const { prisma } = deps;
  const hash = hashToken(token);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AuthError(400, "invalid_token", "This reset link is invalid or has expired.");
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
