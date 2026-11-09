import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isConfidentialOwner,
  resolveEffectivePermissions,
  type PermissionActor,
} from "./effective-permissions.js";

/**
 * Legal Hold coverage and authority (PRD v1.2 RET-5/RET-6, TRSH-4 as amended).
 *
 * A hold sits on one document or one folder. A folder hold covers the folder and its whole subtree,
 * resolved at check time — so a document filed into a held folder *after* the hold was placed is
 * covered from the moment it lands, and a subfolder created later is too. Nothing is copied onto
 * documents; coverage is always derived from the live folder tree.
 *
 * Every destruction path asks `isUnderLegalHold` (or a `HoldIndex` built for a whole department):
 * a person's delete, the daily auto-delete, "Empty trash", a single purge, and the automatic trash
 * purge. That is the enforcement — the UI only hides what the server would refuse anyway.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The trash reason auto-delete records (RET-3), shown in the trash view. */
export const AUTO_DELETE_TRASH_REASON = "Auto-deleted - retention period ended";
/** The hold placed automatically when an auto-deleted document is restored (RET-5). */
export const RESTORED_AFTER_AUTO_DELETE_REASON = "Restored after auto-delete";

/** A folder and every folder above it, nearest first. Bounded against a cyclic parent pointer. */
async function folderAncestry(db: Db, organizationId: string, folderId: string): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder: { id: string; parentFolderId: string | null } | null = await db.folder.findFirst({
      where: { id: current, organizationId },
      select: { id: true, parentFolderId: true },
    });
    if (!folder) break;
    ids.push(folder.id);
    current = folder.parentFolderId;
  }
  return ids;
}

export interface CoveringHold {
  id: string;
  /** "document" = placed on this document; "folder" = inherited from a folder hold. */
  scope: "document" | "folder";
  folderId: string | null;
  folderName: string | null;
  reason: string;
  placedAt: Date;
  placedByName: string;
}

/** Every active hold that covers a document — its own, and any on its folder or an ancestor. */
export async function activeHoldsCovering(
  db: Db,
  organizationId: string,
  document: { id: string; folderId: string },
): Promise<CoveringHold[]> {
  const ancestry = await folderAncestry(db, organizationId, document.folderId);
  const holds = await db.legalHold.findMany({
    where: {
      organizationId,
      removedAt: null,
      OR: [{ documentId: document.id }, { folderId: { in: ancestry } }],
    },
    include: {
      folder: { select: { name: true } },
      placedBy: { select: { fullName: true } },
    },
    orderBy: { placedAt: "asc" },
  });
  return holds.map((h) => ({
    id: h.id,
    scope: h.documentId ? "document" : "folder",
    folderId: h.folderId,
    folderName: h.folder?.name ?? null,
    reason: h.reason,
    placedAt: h.placedAt,
    placedByName: h.placedBy.fullName,
  }));
}

export async function isUnderLegalHold(
  db: Db,
  organizationId: string,
  document: { id: string; folderId: string },
): Promise<boolean> {
  const ancestry = await folderAncestry(db, organizationId, document.folderId);
  const hold = await db.legalHold.findFirst({
    where: {
      organizationId,
      removedAt: null,
      OR: [{ documentId: document.id }, { folderId: { in: ancestry } }],
    },
    select: { id: true },
  });
  return hold !== null;
}

/** Active holds on any strict ancestor of a folder — the holds a folder inherits (not its own). */
export async function inheritedFolderHolds(
  db: Db,
  organizationId: string,
  folderId: string,
): Promise<{ id: string; folderId: string; folderName: string }[]> {
  const ancestors = (await folderAncestry(db, organizationId, folderId)).slice(1);
  if (ancestors.length === 0) return [];
  const holds = await db.legalHold.findMany({
    where: { organizationId, removedAt: null, folderId: { in: ancestors } },
    include: { folder: { select: { name: true } } },
  });
  return holds.map((h) => ({ id: h.id, folderId: h.folderId!, folderName: h.folder?.name ?? "" }));
}

/** Folder ids from a folder up to the root (inclusive) — exported for the move-out-of-hold check. */
export async function folderAndAncestors(db: Db, organizationId: string, folderId: string): Promise<string[]> {
  return folderAncestry(db, organizationId, folderId);
}

/**
 * One department's holds, resolved once, for bulk checks — the daily run and the listings would
 * otherwise walk the folder tree per document.
 */
export interface HoldIndex {
  isHeld(document: { id: string; folderId: string }): boolean;
  /** Folders under an active folder hold (the held folder and all its descendants). */
  coveredFolderIds: Set<string>;
}

export async function loadHoldIndex(db: Db, organizationId: string, departmentId: string): Promise<HoldIndex> {
  const [holds, folders] = await Promise.all([
    db.legalHold.findMany({
      where: { organizationId, departmentId, removedAt: null },
      select: { documentId: true, folderId: true },
    }),
    db.folder.findMany({
      where: { organizationId, departmentId },
      select: { id: true, parentFolderId: true },
    }),
  ]);

  const heldDocuments = new Set(holds.map((h) => h.documentId).filter((id): id is string => Boolean(id)));
  const heldFolders = new Set(holds.map((h) => h.folderId).filter((id): id is string => Boolean(id)));

  const parentOf = new Map(folders.map((f) => [f.id, f.parentFolderId]));
  const covered = new Set<string>();
  for (const folder of folders) {
    let current: string | null | undefined = folder.id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (heldFolders.has(current)) {
        covered.add(folder.id);
        break;
      }
      current = parentOf.get(current);
    }
  }

  return {
    isHeld: (document) => heldDocuments.has(document.id) || covered.has(document.folderId),
    coveredFolderIds: covered,
  };
}

export type HoldAuthority = "allowed" | "forbidden" | "not_found";

/**
 * Who may place or remove a hold on something in a folder (RET-5), and — because restoring an
 * auto-deleted document places one — who may restore an auto-deleted document:
 *
 *  - Outside a confidential folder: the holder of `retention.manage_legal_hold` there (Department
 *    Admins by default; the Super Admin's administrative baseline does not include it).
 *  - Inside a confidential folder: the folder's **Owner** on the named list, and only them.
 *
 * Something the actor can't see is `not_found`, so the answer never confirms that a confidential
 * document exists (Feature Spec §11.2).
 */
export async function legalHoldAuthority(
  prisma: PrismaClient,
  actor: PermissionActor,
  departmentId: string,
  folderId: string,
): Promise<HoldAuthority> {
  const resolved = await resolveEffectivePermissions(prisma, actor, departmentId, folderId);
  if (resolved.permissions["documents.view"] !== true) return "not_found";
  if (resolved.isConfidential) {
    return (await isConfidentialOwner(prisma, actor, folderId)) ? "allowed" : "forbidden";
  }
  return resolved.permissions["retention.manage_legal_hold"] === true ? "allowed" : "forbidden";
}
