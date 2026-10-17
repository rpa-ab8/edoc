import type { PrismaClient } from "@prisma/client";
import type { PermissionActor } from "./effective-permissions.js";

/**
 * Share-by-reference access resolution — the single place a *recipient's* access to a document
 * through a share is decided, kept beside `effective-permissions.ts` (which decides access through
 * the department/folder/role chain). The two are consulted in that order by the document module:
 * the role chain first, and a share only as a fallback for someone the chain doesn't already admit.
 *
 * A share never grants more than view + download. The home department keeps everything else — a
 * recipient can never edit, delete, add a version, re-share, or override retention (Feature Spec
 * §7.2, "the home department retains control"). Sharing is by reference, so revocation is instant
 * and complete: flip the row and the access is gone, because no copy was ever made (SHR-1).
 */

export type SharedPermission = "view" | "download";

interface ShareableDocument {
  id: string;
  organizationId: string;
}

/**
 * The strongest permission any active, accepted, unexpired share grants this actor for this
 * document — or null if none does. A share reaches the actor when it targets them directly
 * (`targetType = user`) or targets a department they are an active member of (`targetType =
 * department`, and already accepted so its status is `active`). External-link shares are
 * deliberately ignored here: they confer access to an anonymous link holder, not to a signed-in
 * user, and are resolved separately by token.
 *
 * `download` outranks `view`, so a person reached by two shares gets the more permissive of them.
 */
export async function resolveSharedAccess(
  prisma: PrismaClient,
  actor: PermissionActor,
  document: ShareableDocument,
): Promise<{ permission: SharedPermission } | null> {
  const now = new Date();

  const departmentIds = (
    await prisma.membership.findMany({
      where: { organizationId: actor.organizationId, userId: actor.userId, status: "active" },
      select: { departmentId: true },
    })
  ).map((m) => m.departmentId);

  const targetClauses = [
    { targetType: "user" as const, targetUserId: actor.userId },
    ...(departmentIds.length > 0
      ? [{ targetType: "department" as const, targetDepartmentId: { in: departmentIds } }]
      : []),
  ];

  const shares = await prisma.share.findMany({
    where: {
      organizationId: actor.organizationId,
      documentId: document.id,
      status: "active",
      OR: targetClauses,
    },
    select: { permission: true, expiresAt: true },
  });

  let best: SharedPermission | null = null;
  for (const share of shares) {
    // An expired share confers nothing even before the sweep flips its status (SHR-6: expired
    // shares auto-revoke). A null expiry never expires.
    if (share.expiresAt && share.expiresAt <= now) continue;
    if (share.permission === "download") return { permission: "download" };
    best = "view";
  }
  return best ? { permission: best } : null;
}
