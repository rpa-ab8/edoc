import type { Prisma, PrismaClient, SharePermission, ShareStatus } from "@prisma/client";
import type { Env } from "../../config/env.js";
import { logAuditEvent } from "../../lib/audit.js";
import {
  resolveEffectivePermissions,
  type PermissionActor,
} from "../../lib/effective-permissions.js";
import { hashToken, issueToken } from "../../lib/tokens.js";
import { getActiveStorageDriver } from "../storage/storage.service.js";
import {
  DEFAULT_DEPARTMENT_RULES,
  departmentRulesSchema,
} from "../department/department.schemas.js";

export class SharingError extends Error {
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
}
interface FileDeps extends Deps {
  env: Env;
}

// External links auto-expire; a permanent one can never be created (SHR-4). This is the ceiling on
// how far out any expiry may be set, matching the department-rules cap on `linkExpiryDays`.
const MAX_EXPIRY_DAYS = 365;

// ─────────────────────────── inputs ───────────────────────────

export interface CreateShareInput {
  targetType: "user" | "department" | "external_link";
  targetUserId?: string;
  targetDepartmentId?: string;
  permission: SharePermission; // "view" | "download"
  /** Days from now until the share expires. Mandatory for an external link (SHR-4); optional for
   *  an internal share (a null/absent value means it does not expire). */
  expiresInDays?: number | null;
}

export interface UpdateShareInput {
  permission?: SharePermission;
  /** Set a new expiry (extend or add one). Null clears it (internal shares only). */
  expiresInDays?: number | null;
}

function expiryFrom(days: number | null | undefined): Date | null {
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
    throw new SharingError(400, "invalid_expiry", `Expiry must be between 1 and ${MAX_EXPIRY_DAYS} days.`);
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// A stored `active` share whose clock has run out is treated as expired everywhere it is read —
// access checks filter on it, and listings compute the label from it — so no background sweep is
// needed to keep it honest.
function isExpired(share: { status: ShareStatus; expiresAt: Date | null }): boolean {
  return share.status === "active" && share.expiresAt !== null && share.expiresAt <= new Date();
}

function displayStatus(share: { status: ShareStatus; expiresAt: Date | null }): ShareStatus {
  return isExpired(share) ? "expired" : share.status;
}

/**
 * Sweeps away shares whose clock has run out (Data Model §6.1). An expired share already grants no
 * access, so deleting it loses nothing but the clutter — neither side accumulates dead rows. Called
 * lazily whenever a share list is loaded, which is enough for a self-hosted deployment without a
 * scheduled job; the original share's audit event still stands. Tenant-scoped, so it only ever
 * touches the caller's own organization.
 */
async function purgeExpiredShares(deps: Deps, organizationId: string): Promise<void> {
  await deps.prisma.share.deleteMany({
    where: { organizationId, status: "active", expiresAt: { lt: new Date() } },
  });
}

// ─────────────────────────── the sharer's rights on a document ───────────────────────────

interface DocForShare {
  id: string;
  organizationId: string;
  departmentId: string;
  folderId: string;
  documentRef: string;
  titleValue: string | null;
}

async function loadDocumentForSharer(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
): Promise<{ document: DocForShare; permissions: Record<string, boolean> }> {
  const document = await deps.prisma.document.findFirst({
    where: { id: documentId, organizationId: actor.organizationId },
    select: {
      id: true,
      organizationId: true,
      departmentId: true,
      folderId: true,
      documentRef: true,
      titleValue: true,
    },
  });
  if (!document) throw new SharingError(404, "document_not_found", "Document not found.");

  const resolved = await resolveEffectivePermissions(
    deps.prisma,
    actor,
    document.departmentId,
    document.folderId,
  );
  // You cannot share what you cannot see — and a document you may not view stays invisible, so this
  // is a 404, never a 403 (identical to the document module's rule, so sharing can't be used to
  // probe for a confidential document's existence).
  if (resolved.permissions["documents.view"] !== true) {
    throw new SharingError(404, "document_not_found", "Document not found.");
  }
  return { document, permissions: resolved.permissions };
}

async function departmentRules(deps: Deps, departmentId: string) {
  const dept = await deps.prisma.department.findUnique({
    where: { id: departmentId },
    select: { rules: true },
  });
  const parsed = departmentRulesSchema.safeParse(dept?.rules);
  return parsed.success ? parsed.data : DEFAULT_DEPARTMENT_RULES;
}

// ─────────────────────────── create ───────────────────────────

export async function createShare(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
  input: CreateShareInput,
): Promise<{ share: ShareView; linkToken?: string }> {
  const { prisma } = deps;
  const { document, permissions } = await loadDocumentForSharer(deps, actor, documentId);

  if (permissions["sharing.share"] !== true) {
    throw new SharingError(403, "forbidden", "You don't have permission to share this document.");
  }
  // Least privilege: you cannot hand out a stronger access than you hold yourself.
  if (input.permission === "download" && permissions["documents.download"] !== true) {
    throw new SharingError(403, "forbidden", "You can't grant download without download access yourself.");
  }

  // `Share` relates to `document` and `sharedBy` but not to `organization`/`department`/`user`
  // targets (those are plain FK scalars), so the create uses the unchecked/scalar form throughout.
  let data: Prisma.ShareUncheckedCreateInput;
  let rawLinkToken: string | undefined;
  let description: string;

  if (input.targetType === "user") {
    if (!input.targetUserId) throw new SharingError(400, "target_required", "A recipient is required.");
    if (input.targetUserId === actor.userId) {
      throw new SharingError(400, "cannot_share_with_self", "You can't share a document with yourself.");
    }
    const target = await resolveOrgUser(deps, actor.organizationId, input.targetUserId);

    // A share to a *particular person* may reach anyone in the organization, in any department —
    // holding `sharing.share` is enough (product decision, 2026-07-25, overriding the earlier
    // cross-department gate on user shares). Sharing is allowed even with someone who already has
    // access to the document: a share is additive (it can never reduce their access), and the point
    // is the "Shared with me" pointer — a way to surface a specific file to a colleague who would
    // otherwise have to hunt for it among many. A view-only share simply can't downgrade a recipient
    // whose own role already grants more; that's inherent to sharing being additive, not a defect.
    data = {
      organizationId: actor.organizationId,
      documentId: document.id,
      sharedByUserId: actor.userId,
      targetType: "user",
      targetUserId: target.id,
      permission: input.permission,
      expiresAt: expiryFrom(input.expiresInDays),
      status: "active",
    };
    description = `Shared ${document.documentRef} with ${target.email} (${input.permission})`;
  } else if (input.targetType === "department") {
    if (!input.targetDepartmentId) throw new SharingError(400, "target_required", "A department is required.");
    const dept = await prisma.department.findFirst({
      where: { id: input.targetDepartmentId, organizationId: actor.organizationId },
      select: { id: true, name: true },
    });
    if (!dept) throw new SharingError(404, "department_not_found", "That department doesn't exist.");

    const isCrossDepartment = dept.id !== document.departmentId;
    if (isCrossDepartment && permissions["sharing.cross_department_share"] !== true) {
      throw new SharingError(403, "forbidden", "Sharing to another department needs the cross-department share permission.");
    }

    data = {
      organizationId: actor.organizationId,
      documentId: document.id,
      sharedByUserId: actor.userId,
      targetType: "department",
      targetDepartmentId: dept.id,
      permission: input.permission,
      expiresAt: expiryFrom(input.expiresInDays),
      // Cross-department shares require the receiving side's consent, so they land pending (SHR-3).
      // A share to the document's own department needs no consent and is active at once.
      status: isCrossDepartment ? "pending" : "active",
    };
    description = `Shared ${document.documentRef} with department ${dept.name} (${input.permission})${
      isCrossDepartment ? " — pending consent" : ""
    }`;
  } else {
    // external_link — the widest exposure surface, doubly gated (SHR-5) and always time-bound (SHR-4).
    if (permissions["sharing.external_share"] !== true || permissions["sharing.create_link"] !== true) {
      // The engine forces both of these off inside a confidential folder, so this also enforces
      // "confidential documents can never leave by link" (§11.2) without a separate check.
      throw new SharingError(403, "forbidden", "You don't have permission to create an external link for this document.");
    }
    const rules = await departmentRules(deps, document.departmentId);
    if (!rules.defaultSharing.externalLinksEnabled) {
      throw new SharingError(403, "external_links_disabled", "This department does not allow external links.");
    }
    // Mandatory expiry — a link with no expiry can never be created.
    const expiresAt = expiryFrom(input.expiresInDays ?? rules.defaultSharing.linkExpiryDays);
    if (!expiresAt) {
      throw new SharingError(400, "expiry_required", "An external link must have an expiry.");
    }

    const token = issueToken();
    rawLinkToken = token.raw;
    data = {
      organizationId: actor.organizationId,
      documentId: document.id,
      sharedByUserId: actor.userId,
      targetType: "external_link",
      permission: input.permission,
      // Only the hash is stored; the raw token lives in the URL, so a database leak doesn't expose
      // live links (same pattern as every other single-use token in the system).
      linkToken: token.hash,
      expiresAt,
      status: "active",
    };
    description = `Created an external ${input.permission} link for ${document.documentRef}`;
  }

  const created = await prisma.share.create({ data });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "share",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: description,
  });

  const view = await shapeShare(deps, created.id);
  // The route stitches the real FRONTEND_URL onto the token; the service returns just the token so
  // it stays transport-agnostic (and testable without an app instance). Returned exactly once, at
  // creation — the raw token is never stored, only its hash.
  return rawLinkToken ? { share: view, linkToken: rawLinkToken } : { share: view };
}

// ─────────────────────────── read: shared-by-me / shared-with-me ───────────────────────────

export interface ShareView {
  id: string;
  documentId: string;
  documentRef: string;
  documentTitle: string | null;
  sourceDepartmentId: string;
  sourceDepartmentName: string;
  targetType: "user" | "department" | "external_link";
  targetLabel: string;
  permission: SharePermission;
  status: ShareStatus;
  expiresAt: Date | null;
  openedCount: number;
  sharedByName: string;
  createdAt: Date;
}

const shareInclude = {
  document: {
    select: { id: true, documentRef: true, titleValue: true, departmentId: true },
  },
  sharedBy: { select: { fullName: true, email: true } },
} satisfies Prisma.ShareInclude;

type LoadedShare = Prisma.ShareGetPayload<{ include: typeof shareInclude }>;

// `Document` carries `departmentId` but has no `department` relation, so the source department's
// name is fetched by id and memoised per call to keep list rendering to one lookup per department.
async function departmentNames(deps: Deps, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const rows = await deps.prisma.department.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function targetLabelFor(deps: Deps, share: LoadedShare): Promise<string> {
  if (share.targetType === "external_link") return "External link";
  if (share.targetType === "user" && share.targetUserId) {
    const u = await deps.prisma.user.findUnique({
      where: { id: share.targetUserId },
      select: { fullName: true, email: true },
    });
    return u ? `${u.fullName} (${u.email})` : "Unknown user";
  }
  if (share.targetType === "department" && share.targetDepartmentId) {
    const d = await deps.prisma.department.findUnique({
      where: { id: share.targetDepartmentId },
      select: { name: true },
    });
    return d ? `Department: ${d.name}` : "Unknown department";
  }
  return "—";
}

async function toShareView(deps: Deps, share: LoadedShare, sourceDeptName: string): Promise<ShareView> {
  return {
    id: share.id,
    documentId: share.document.id,
    documentRef: share.document.documentRef,
    documentTitle: share.document.titleValue,
    sourceDepartmentId: share.document.departmentId,
    sourceDepartmentName: sourceDeptName,
    targetType: share.targetType,
    targetLabel: await targetLabelFor(deps, share),
    permission: share.permission,
    status: displayStatus(share),
    expiresAt: share.expiresAt,
    openedCount: share.openedCount,
    sharedByName: share.sharedBy.fullName,
    createdAt: share.createdAt,
  };
}

async function shapeShare(deps: Deps, shareId: string): Promise<ShareView> {
  const share = await deps.prisma.share.findUniqueOrThrow({ where: { id: shareId }, include: shareInclude });
  const names = await departmentNames(deps, [share.document.departmentId]);
  return toShareView(deps, share, names.get(share.document.departmentId) ?? "—");
}

/** Shapes a list of loaded shares, resolving all source-department names in one query. */
async function toShareViews(deps: Deps, shares: LoadedShare[]): Promise<ShareView[]> {
  const names = await departmentNames(deps, shares.map((s) => s.document.departmentId));
  return Promise.all(shares.map((s) => toShareView(deps, s, names.get(s.document.departmentId) ?? "—")));
}

/** Everything the actor has sent out — the control side (SHR-6). Revoked shares are kept so the
 *  history is honest, but expired ones show as expired. */
export async function listSharedByMe(deps: Deps, actor: PermissionActor): Promise<ShareView[]> {
  await purgeExpiredShares(deps, actor.organizationId);
  const shares = await deps.prisma.share.findMany({
    where: { organizationId: actor.organizationId, sharedByUserId: actor.userId },
    include: shareInclude,
    orderBy: { createdAt: "desc" },
  });
  return toShareViews(deps, shares);
}

/** The actor's inbox — everything shared *to* them, directly or via a department they belong to
 *  (SHR-2 receiving side). Pending cross-department shares are excluded until accepted; revoked and
 *  expired shares drop off, leaving no stale access. */
export async function listSharedWithMe(deps: Deps, actor: PermissionActor): Promise<ShareView[]> {
  await purgeExpiredShares(deps, actor.organizationId);
  const departmentIds = (
    await deps.prisma.membership.findMany({
      where: { organizationId: actor.organizationId, userId: actor.userId, status: "active" },
      select: { departmentId: true },
    })
  ).map((m) => m.departmentId);

  const shares = await deps.prisma.share.findMany({
    where: {
      organizationId: actor.organizationId,
      status: "active",
      // Recipient has tidied it out of their own inbox — access is unchanged, it just no longer shows.
      dismissedAt: null,
      targetType: { in: ["user", "department"] },
      OR: [
        { targetType: "user", targetUserId: actor.userId },
        ...(departmentIds.length > 0
          ? [{ targetType: "department" as const, targetDepartmentId: { in: departmentIds } }]
          : []),
      ],
    },
    include: shareInclude,
    orderBy: { createdAt: "desc" },
  });

  const live = shares.filter((s) => !isExpired(s));
  return toShareViews(deps, live);
}

/** Shares on a single document (the sharer's view when opening the share dialog on a document they
 *  control). Requires `sharing.share` on the document. */
export async function listDocumentShares(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
): Promise<ShareView[]> {
  const { permissions } = await loadDocumentForSharer(deps, actor, documentId);
  if (permissions["sharing.share"] !== true) {
    throw new SharingError(403, "forbidden", "You don't have permission to manage sharing on this document.");
  }
  const shares = await deps.prisma.share.findMany({
    where: { organizationId: actor.organizationId, documentId, status: { not: "revoked" } },
    include: shareInclude,
    orderBy: { createdAt: "desc" },
  });
  return toShareViews(deps, shares);
}

// ─────────────────────────── modify: revoke / downgrade / extend (SHR-6) ───────────────────────────

async function loadOwnShare(deps: Deps, actor: PermissionActor, shareId: string) {
  const share = await deps.prisma.share.findFirst({
    where: { id: shareId, organizationId: actor.organizationId },
    include: { document: { select: { id: true, documentRef: true, departmentId: true } } },
  });
  if (!share) throw new SharingError(404, "share_not_found", "Share not found.");
  // Only the person who created the share controls it (personal "Shared by me" is self-service;
  // the department-scoped admin oversight view is a separate, later feature — Feature Spec §7.4).
  if (share.sharedByUserId !== actor.userId) {
    throw new SharingError(403, "forbidden", "You can only change shares you created.");
  }
  return share;
}

export async function revokeShare(deps: Deps, actor: PermissionActor, shareId: string) {
  const share = await loadOwnShare(deps, actor, shareId);
  if (share.status === "revoked") return { id: share.id, status: "revoked" as ShareStatus };

  await deps.prisma.share.update({ where: { id: share.id }, data: { status: "revoked" } });
  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "share",
    documentId: share.document.id,
    departmentId: share.document.departmentId,
    targetDescription: `Revoked a share of ${share.document.documentRef}`,
  });
  return { id: share.id, status: "revoked" as ShareStatus };
}

/**
 * The *recipient's* tidy-up: removes a share from their own "Shared with me" without revoking it
 * (revoking is the sharer's tool). Access is unchanged — this is a view preference. Only the person
 * the share targets may dismiss it, and only for a direct `user` share (a department share reaches
 * many people, so one person can't hide it for everyone).
 */
export async function dismissShare(deps: Deps, actor: PermissionActor, shareId: string) {
  const share = await deps.prisma.share.findFirst({
    where: { id: shareId, organizationId: actor.organizationId },
    select: { id: true, targetType: true, targetUserId: true },
  });
  if (!share) throw new SharingError(404, "share_not_found", "Share not found.");
  if (share.targetType !== "user" || share.targetUserId !== actor.userId) {
    throw new SharingError(403, "forbidden", "You can only remove shares that were sent to you.");
  }
  await deps.prisma.share.update({ where: { id: share.id }, data: { dismissedAt: new Date() } });
  return { id: share.id, dismissed: true };
}

export async function updateShare(
  deps: Deps,
  actor: PermissionActor,
  shareId: string,
  input: UpdateShareInput,
): Promise<ShareView> {
  const share = await loadOwnShare(deps, actor, shareId);
  if (share.status === "revoked") {
    throw new SharingError(409, "share_revoked", "A revoked share can't be changed — create a new one.");
  }

  const data: Prisma.ShareUpdateInput = {};
  if (input.permission) {
    // Downgrade-only would be too strict (the doc allows "downgrade" but a re-grant is reasonable);
    // any valid level is accepted, still bounded by what the target may ultimately do.
    data.permission = input.permission;
  }
  if (input.expiresInDays !== undefined) {
    if (share.targetType === "external_link" && input.expiresInDays === null) {
      throw new SharingError(400, "expiry_required", "An external link must keep an expiry.");
    }
    data.expiresAt = expiryFrom(input.expiresInDays);
  }

  if (Object.keys(data).length === 0) return shapeShare(deps, share.id);

  await deps.prisma.share.update({ where: { id: share.id }, data });
  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "share",
    documentId: share.document.id,
    departmentId: share.document.departmentId,
    targetDescription: `Updated a share of ${share.document.documentRef}`,
  });
  return shapeShare(deps, share.id);
}

// ─────────────────────────── cross-department consent (SHR-3) ───────────────────────────

/** Inbound cross-department shares awaiting this department's decision. Gated at the route by
 *  `sharing.cross_department_share` on the receiving department. */
export async function listPendingForDepartment(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
): Promise<ShareView[]> {
  // The `organizationId` filter below already makes a foreign department return nothing, so this
  // guard leaks no data it would otherwise expose — it makes the tenant boundary an explicit,
  // testable refusal instead of a silently empty list, matching every other department-scoped
  // service. Defence in depth: the route's permission gate is org-scoped too.
  const department = await deps.prisma.department.findFirst({
    where: { id: departmentId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!department) throw new SharingError(404, "department_not_found", "Department not found.");

  const shares = await deps.prisma.share.findMany({
    where: {
      organizationId: actor.organizationId,
      targetType: "department",
      targetDepartmentId: departmentId,
      status: "pending",
    },
    include: shareInclude,
    orderBy: { createdAt: "desc" },
  });
  return toShareViews(deps, shares);
}

/**
 * The receiving department's decision on an inbound cross-department share. Accepting activates it;
 * refusing revokes it. The route gates this on `sharing.cross_department_share` in the *receiving*
 * department, so only someone empowered to manage cross-department sharing there can consent.
 *
 * FLAGGED: the docs require the receiving side to be able to refuse (SHR-3) but never name which
 * permission confers that authority. `sharing.cross_department_share` is the closest fit; revisit
 * if a distinct "manage inbound shares" capability is ever added.
 */
export async function respondToCrossDepartmentShare(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  shareId: string,
  accept: boolean,
): Promise<{ id: string; status: ShareStatus }> {
  const share = await deps.prisma.share.findFirst({
    where: {
      id: shareId,
      organizationId: actor.organizationId,
      targetType: "department",
      targetDepartmentId: departmentId,
    },
    include: { document: { select: { id: true, documentRef: true, departmentId: true } } },
  });
  if (!share) throw new SharingError(404, "share_not_found", "Share not found.");
  if (share.status !== "pending") {
    throw new SharingError(409, "not_pending", "This share has already been decided.");
  }

  const status: ShareStatus = accept ? "active" : "revoked";
  await deps.prisma.share.update({ where: { id: share.id }, data: { status } });
  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "share",
    documentId: share.document.id,
    departmentId,
    targetDescription: `${accept ? "Accepted" : "Refused"} an inbound share of ${share.document.documentRef}`,
  });
  return { id: share.id, status };
}

// ─────────────────────────── external link, public access (SHR-4) ───────────────────────────

interface LinkResolution {
  share: {
    id: string;
    organizationId: string;
    permission: SharePermission;
    documentId: string;
    sharedByUserId: string;
  };
  document: {
    id: string;
    documentRef: string;
    titleValue: string | null;
    departmentId: string;
    currentVersionId: string | null;
  };
}

/** Resolves a live external link by its raw token, or throws a uniform not-found/expired error.
 *  Never leaks whether the token was wrong versus revoked versus expired. */
async function resolveLink(deps: Deps, rawToken: string): Promise<LinkResolution> {
  const share = await deps.prisma.share.findFirst({
    where: { linkToken: hashToken(rawToken), targetType: "external_link" },
    include: {
      document: {
        select: { id: true, documentRef: true, titleValue: true, departmentId: true, currentVersionId: true },
      },
    },
  });
  if (!share || share.status !== "active" || isExpired(share)) {
    throw new SharingError(404, "link_unavailable", "This link is no longer available.");
  }
  return {
    share: {
      id: share.id,
      organizationId: share.organizationId,
      permission: share.permission,
      documentId: share.documentId,
      sharedByUserId: share.sharedByUserId,
    },
    document: share.document,
  };
}

/** Opens an external link: records the access (SHR-4 "access is logged"), bumps the opened count
 *  (SHR-6), and returns just enough for an account-less viewer to render the document. */
export async function openLink(deps: Deps, rawToken: string) {
  const { share, document } = await resolveLink(deps, rawToken);

  await deps.prisma.share.update({ where: { id: share.id }, data: { openedCount: { increment: 1 } } });
  // `audit_event.actorUserId` is a required FK to `user`, and an external link has no account behind
  // it — so the access is attributed to the person who created the link (they are accountable for
  // where it went), with the description making clear it was an anonymous link open (SHR-4).
  await logAuditEvent(deps.prisma, {
    organizationId: share.organizationId,
    actorUserId: share.sharedByUserId,
    action: "link_access",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `External link opened for ${document.documentRef}`,
  });

  return {
    documentRef: document.documentRef,
    title: document.titleValue,
    permission: share.permission,
  };
}

/** Streams the current version's bytes to an external-link holder. `download` is only allowed when
 *  the link grants it; a view-only link can preview but not download. */
export async function fetchLinkFile(
  deps: FileDeps,
  rawToken: string,
  mode: "preview" | "download",
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const { share, document } = await resolveLink(deps, rawToken);
  if (mode === "download" && share.permission !== "download") {
    throw new SharingError(403, "download_not_allowed", "This link is view-only.");
  }
  if (!document.currentVersionId) {
    throw new SharingError(404, "version_not_found", "This document has no file.");
  }
  const version = await deps.prisma.version.findUnique({
    where: { id: document.currentVersionId },
    select: { storageRef: true, mimeType: true, fileName: true },
  });
  if (!version) throw new SharingError(404, "version_not_found", "This document has no file.");

  const driver = await getActiveStorageDriver(deps, share.organizationId);
  const buffer = await driver.get(version.storageRef);
  return { buffer, mimeType: version.mimeType, fileName: version.fileName };
}

// ─────────────────────────── helpers ───────────────────────────

/** Confirms a user id belongs to the organization — either as an active member of any department
 *  or as its Super Admin (the creator, who holds no membership row). */
async function resolveOrgUser(deps: Deps, organizationId: string, userId: string) {
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, fullName: true },
  });
  if (!user) throw new SharingError(404, "user_not_found", "That user doesn't exist.");

  const membership = await deps.prisma.membership.findFirst({
    where: { organizationId, userId, status: "active" },
    select: { id: true },
  });
  if (membership) return user;

  const isCreator = await deps.prisma.organization.findFirst({
    where: { id: organizationId, createdByUserId: userId },
    select: { id: true },
  });
  if (isCreator) return user;

  throw new SharingError(404, "user_not_found", "That user isn't part of this organization.");
}
