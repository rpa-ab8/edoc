import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Env } from "../../config/env.js";
import { logAuditEvent } from "../../lib/audit.js";
import { hashPassword } from "../../lib/password.js";
import { sendMail } from "../../lib/mailer.js";
import { hashToken, issueToken } from "../../lib/tokens.js";
import { canGrantRole, hasPermission, type PermissionActor } from "../../lib/effective-permissions.js";
import { issueRefreshToken, refreshCookieOptions } from "../auth/auth.service.js";
import { signAccessToken } from "../../lib/jwt.js";

export class InvitationError extends Error {
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

// Not env-configurable on purpose: an invitation is a standing grant of access to an
// organization's documents, so its lifetime is a security property rather than a preference.
// A week is long enough to survive a holiday and short enough that a forgotten invite lapses.
const INVITATION_TTL_DAYS = 7;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function requireInviteRights(deps: Deps, actor: PermissionActor, departmentId: string) {
  const department = await deps.prisma.department.findFirst({
    where: { id: departmentId, organizationId: actor.organizationId },
  });
  if (!department) {
    throw new InvitationError(404, "department_not_found", "Department not found.");
  }
  // Routes already gate on `members.invite` via requirePermission; this is the service-level
  // guarantee so the rule holds no matter who calls it.
  if (!(await hasPermission(deps.prisma, actor, departmentId, "members.invite"))) {
    throw new InvitationError(403, "forbidden", "You can't invite people to this department.");
  }
  return department;
}

function inviteUrl(env: Env, rawToken: string): string {
  return `${env.FRONTEND_URL}/invitations/${rawToken}`;
}

async function sendInviteEmail(
  env: Env,
  to: string,
  context: { organizationName: string; departmentName: string; roleName: string; inviterName: string; url: string },
) {
  try {
    await sendMail(env, {
      to,
      subject: `${context.inviterName} invited you to ${context.organizationName} on Edoc`,
      text:
        `${context.inviterName} has invited you to join ${context.organizationName} on Edoc.\n\n` +
        `Department: ${context.departmentName}\n` +
        `Role: ${context.roleName}\n\n` +
        `Accept the invitation:\n${context.url}\n\n` +
        `This invitation expires in ${INVITATION_TTL_DAYS} days. If you weren't expecting it, ignore this email.`,
    });
  } catch (err) {
    // The provider's reason (bad key, unauthorised IP, unverified sender…) is for whoever runs the
    // server, not for the person clicking Invite — log it here, tell them what they can act on.
    console.error(`[invitation] email to ${to} failed:`, err instanceof Error ? err.message : err);
    throw new InvitationError(
      502,
      "email_send_failed",
      "We couldn't send the invitation email, so no invitation was created. Try again, or ask an administrator to check the email settings.",
    );
  }
}

export async function listInvitations(deps: Deps, organizationId: string, departmentId?: string) {
  const invitations = await deps.prisma.invitation.findMany({
    where: { organizationId, status: "pending", ...(departmentId ? { departmentId } : {}) },
    orderBy: { createdAt: "desc" },
    include: { invitedBy: { select: { fullName: true, email: true } } },
  });

  const departments = await deps.prisma.department.findMany({ where: { organizationId } });
  const roles = await deps.prisma.role.findMany({ where: { organizationId } });

  return invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    departmentId: invitation.departmentId,
    departmentName: departments.find((d) => d.id === invitation.departmentId)?.name ?? "—",
    roleId: invitation.roleId,
    roleName: roles.find((r) => r.id === invitation.roleId)?.name ?? "—",
    invitedBy: invitation.invitedBy.fullName,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    // Surfaced so the UI can say "expired" without a second round of date maths.
    isExpired: invitation.expiresAt.getTime() < Date.now(),
  }));
}

export async function createInvitation(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  input: { email: string; roleId: string },
) {
  const { prisma, env } = deps;
  const department = await requireInviteRights(deps, actor, departmentId);
  const email = normalizeEmail(input.email);

  const role = await prisma.role.findFirst({ where: { id: input.roleId, departmentId } });
  if (!role) {
    throw new InvitationError(404, "role_not_found", "That role isn't in this department.");
  }
  if (!(await canGrantRole(prisma, actor, departmentId, role.permissions))) {
    throw new InvitationError(
      403,
      "role_exceeds_yours",
      "You can't invite someone with a role that has more access than your own.",
    );
  }

  // Data Model §2.3: inviting an email that already has an account creates a *membership*, not a
  // second account — so the only thing that blocks an invite is already holding a role here.
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const membership = await prisma.membership.findUnique({
      where: { userId_departmentId: { userId: existingUser.id, departmentId } },
    });
    if (membership) {
      throw new InvitationError(
        409,
        "already_a_member",
        "That person already has a role in this department.",
      );
    }
  }

  const pending = await prisma.invitation.findFirst({
    where: { organizationId: actor.organizationId, departmentId, email, status: "pending" },
  });
  if (pending) {
    throw new InvitationError(
      409,
      "invitation_pending",
      "An invitation is already open for that address — resend it instead.",
    );
  }

  const { raw, hash } = issueToken();
  const invitation = await prisma.invitation.create({
    data: {
      organizationId: actor.organizationId,
      departmentId,
      roleId: role.id,
      email,
      invitedByUserId: actor.userId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  const [organization, inviter] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } }),
    prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
  ]);

  try {
    await sendInviteEmail(env, email, {
      organizationName: organization.name,
      departmentName: department.name,
      roleName: role.name,
      inviterName: inviter.fullName,
      url: inviteUrl(env, raw),
    });
  } catch (err) {
    // No email went out, so nobody holds the link: remove the invitation rather than leave a
    // pending one that blocks inviting this address again ("resend it instead") for an email
    // that was never delivered. Resend (below) keeps its invitation — that one was already sent.
    await prisma.invitation.deleteMany({ where: { id: invitation.id, status: "pending" } });
    throw err;
  }

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "member_change",
    departmentId,
    targetDescription: `Invitation sent to ${email} as ${role.name}`,
  });

  return { id: invitation.id, email, expiresAt: invitation.expiresAt };
}

async function loadInvitationForActor(deps: Deps, actor: PermissionActor, invitationId: string) {
  const invitation = await deps.prisma.invitation.findFirst({
    where: { id: invitationId, organizationId: actor.organizationId },
  });
  if (!invitation) {
    throw new InvitationError(404, "invitation_not_found", "Invitation not found.");
  }
  await requireInviteRights(deps, actor, invitation.departmentId);
  return invitation;
}

export async function revokeInvitation(deps: Deps, actor: PermissionActor, invitationId: string) {
  const { prisma } = deps;
  const invitation = await loadInvitationForActor(deps, actor, invitationId);
  if (invitation.status !== "pending") {
    throw new InvitationError(409, "invitation_not_pending", "That invitation is no longer open.");
  }

  await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "revoked" } });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "member_change",
    departmentId: invitation.departmentId,
    targetDescription: `Invitation to ${invitation.email} revoked`,
  });

  return { revoked: true };
}

export async function resendInvitation(deps: Deps, actor: PermissionActor, invitationId: string) {
  const { prisma, env } = deps;
  const invitation = await loadInvitationForActor(deps, actor, invitationId);
  if (invitation.status !== "pending") {
    throw new InvitationError(409, "invitation_not_pending", "That invitation is no longer open.");
  }

  // Resending rotates the token and restarts the clock, so an old link in an inbox stops working —
  // the same rule the password-reset and verification flows follow.
  const { raw, hash } = issueToken();
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: {
      tokenHash: hash,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  const [organization, department, role, inviter] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } }),
    prisma.department.findUniqueOrThrow({ where: { id: invitation.departmentId } }),
    prisma.role.findUniqueOrThrow({ where: { id: invitation.roleId } }),
    prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
  ]);

  await sendInviteEmail(env, invitation.email, {
    organizationName: organization.name,
    departmentName: department.name,
    roleName: role.name,
    inviterName: inviter.fullName,
    url: inviteUrl(env, raw),
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "member_change",
    departmentId: invitation.departmentId,
    targetDescription: `Invitation to ${invitation.email} resent`,
  });

  return { sent: true };
}

/**
 * Public preview of an invitation, so the accept screen can show what is being offered and
 * whether the recipient needs to set a password. Deliberately returns only what the recipient
 * already knows or is being told (their own email, the org, the department, the role) — never
 * anything about other members.
 */
export async function previewInvitation(deps: Deps, rawToken: string) {
  const { prisma } = deps;
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!invitation) {
    throw new InvitationError(404, "invitation_not_found", "This invitation link isn't valid.");
  }
  if (invitation.status === "revoked") {
    throw new InvitationError(410, "invitation_revoked", "This invitation was withdrawn.");
  }
  if (invitation.status === "accepted") {
    throw new InvitationError(409, "invitation_accepted", "This invitation has already been used.");
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "expired" } });
    throw new InvitationError(410, "invitation_expired", "This invitation has expired — ask for a new one.");
  }

  const [organization, department, role, existingUser] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: invitation.organizationId } }),
    prisma.department.findUniqueOrThrow({ where: { id: invitation.departmentId } }),
    prisma.role.findUniqueOrThrow({ where: { id: invitation.roleId } }),
    prisma.user.findUnique({ where: { email: invitation.email } }),
  ]);

  return {
    email: invitation.email,
    organizationName: organization.name,
    departmentName: department.name,
    roleName: role.name,
    expiresAt: invitation.expiresAt,
    // Drives which form the accept page shows: sign in, or set a password.
    hasAccount: existingUser !== null,
  };
}

export async function acceptInvitation(
  deps: Deps,
  rawToken: string,
  input: { fullName?: string; password?: string },
  authenticatedUserId: string | undefined,
  context: { deviceInfo?: string; ipAddress?: string },
) {
  const { prisma, env } = deps;
  // Re-validates rather than trusting a preview the client may have called minutes ago.
  await previewInvitation(deps, rawToken);

  const invitation = await prisma.invitation.findUniqueOrThrow({
    where: { tokenHash: hashToken(rawToken) },
  });
  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });

  let userId: string;
  let session: { accessToken: string; refreshCookie: { value: string; options: ReturnType<typeof refreshCookieOptions> } } | null =
    null;

  if (existingUser) {
    // The invitation proves control of the inbox, not of the account that already owns that
    // address — so an existing account must be signed in before it can gain a membership.
    if (authenticatedUserId !== existingUser.id) {
      throw new InvitationError(
        401,
        "sign_in_required",
        "Sign in as this email address to accept the invitation.",
      );
    }
    userId = existingUser.id;
  } else {
    if (!input.fullName?.trim() || !input.password) {
      throw new InvitationError(400, "account_details_required", "Enter your name and a password.");
    }
    const created = await prisma.user.create({
      data: {
        email: invitation.email,
        fullName: input.fullName.trim(),
        passwordHash: await hashPassword(input.password),
        // Receiving the token at that address *is* the proof of ownership that email
        // verification would otherwise establish — asking again would be theatre.
        emailVerifiedAt: new Date(),
      },
    });
    userId = created.id;

    const { raw: refreshRaw, ttlMs } = await issueRefreshToken(
      deps,
      userId,
      context.deviceInfo,
      context.ipAddress,
    );
    session = {
      accessToken: signAccessToken(env, {
        sub: userId,
        emailVerified: true,
        organizationId: invitation.organizationId,
      }),
      refreshCookie: { value: refreshRaw, options: refreshCookieOptions(env, ttlMs) },
    };
  }

  await prisma.$transaction([
    prisma.membership.create({
      data: {
        organizationId: invitation.organizationId,
        userId,
        departmentId: invitation.departmentId,
        roleId: invitation.roleId,
        status: "active",
        invitedEmail: invitation.email,
      },
    }),
    prisma.invitation.update({ where: { id: invitation.id }, data: { status: "accepted" } }),
  ]);

  await logAuditEvent(prisma, {
    organizationId: invitation.organizationId,
    actorUserId: userId,
    action: "member_change",
    departmentId: invitation.departmentId,
    targetDescription: `${invitation.email} accepted their invitation`,
  });

  return {
    organizationId: invitation.organizationId,
    departmentId: invitation.departmentId,
    createdAccount: existingUser === null,
    session,
  };
}
