import type { PrismaClient, AuditAction } from "@prisma/client";

/**
 * The actor for events no person caused — the daily auto-delete job and the automatic trash purge
 * (RET-3). Stored as `actorType = system` with no user; shown as "System" everywhere. User ids are
 * UUIDs, so this sentinel can never collide with a real one.
 */
export const SYSTEM_ACTOR = "system" as const;

/** How an audit row's actor is displayed: the person's name, or "System" for a system event. */
export function auditActorName(event: { actorType: "user" | "system"; actor: { fullName: string } | null }): string {
  return event.actorType === "system" ? "System" : (event.actor?.fullName ?? "Unknown user");
}

// Append-only, by construction: this module only ever exposes a create. There is deliberately
// no update/delete export here — CLAUDE.md's hard rule is "no update or delete path, for anyone,
// ever," so don't add one later even for a "fix a typo in target_description" case.
export async function logAuditEvent(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    /** The person who acted, or `SYSTEM_ACTOR` for a scheduled job. */
    actorUserId: string;
    action: AuditAction;
    documentId?: string;
    departmentId?: string;
    targetDescription?: string;
    isConfidential?: boolean;
  },
) {
  const isSystem = input.actorUserId === SYSTEM_ACTOR;
  await prisma.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: isSystem ? null : input.actorUserId,
      actorType: isSystem ? "system" : "user",
      action: input.action,
      documentId: input.documentId,
      departmentId: input.departmentId,
      targetDescription: input.targetDescription,
      isConfidential: input.isConfidential === true || (await documentIsConfidential(prisma, input)),
    },
  });
}

/**
 * Confidential-audit segregation (AUD-5 / CNF-5) decided here, once, rather than by each caller: an
 * event about a document in a confidential folder is confidential, whatever the caller passed.
 * Several callers (download, delete, restore, purge, metadata edit, new version) used to omit the
 * flag, which put confidential activity in the ordinary audit view. Confidentiality propagates down
 * the folder tree (Data Model §4.1), so the document's own folder is enough to decide it.
 */
async function documentIsConfidential(
  prisma: PrismaClient,
  input: { organizationId: string; documentId?: string },
): Promise<boolean> {
  if (!input.documentId) return false;
  const document = await prisma.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
    select: { folder: { select: { isConfidential: true } } },
  });
  return document?.folder.isConfidential === true;
}
