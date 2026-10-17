import type { PrismaClient, AuditAction } from "@prisma/client";

// Append-only, by construction: this module only ever exposes a create. There is deliberately
// no update/delete export here — CLAUDE.md's hard rule is "no update or delete path, for anyone,
// ever," so don't add one later even for a "fix a typo in target_description" case.
export async function logAuditEvent(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    action: AuditAction;
    documentId?: string;
    departmentId?: string;
    targetDescription?: string;
    isConfidential?: boolean;
  },
) {
  await prisma.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      documentId: input.documentId,
      departmentId: input.departmentId,
      targetDescription: input.targetDescription,
      isConfidential: input.isConfidential ?? false,
    },
  });
}
