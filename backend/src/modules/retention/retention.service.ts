import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env.js";
import { SYSTEM_ACTOR, logAuditEvent } from "../../lib/audit.js";
import {
  addDays,
  autoDeleteDueDate,
  autoDeleteUploadCutoff,
  localDate,
  nextDailyRun,
  startOfLocalDate,
  type IsoDate,
} from "../../lib/calendar.js";
import {
  resolveEffectivePermissions,
  unviewableFolderIdsToExclude,
  type PermissionActor,
} from "../../lib/effective-permissions.js";
import { AUTO_DELETE_TRASH_REASON, legalHoldAuthority, loadHoldIndex, type HoldIndex } from "../../lib/legal-hold.js";
import type { PermissionKey } from "../../lib/permissions.js";
import {
  DocumentError,
  TRASH_RETENTION_DAYS,
  destroyTrashedDocument,
  moveDocumentToTrash,
} from "../document/document.service.js";

/**
 * Retention (PRD v1.2 RET-1..8): the per-department auto-delete period, the Upcoming Deletions list,
 * Legal Holds, and the daily run that moves expired documents to trash and permanently removes
 * trash items whose window has ended.
 *
 * Deletion is always two-stage, exactly as for a person's delete: auto-delete only ever moves a
 * document into trash (recoverable for the trash window); the automatic trash purge is the only
 * place the System destroys data, and a Legal Hold stops both.
 */

export class RetentionError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface Deps {
  prisma: PrismaClient;
  env: Env;
}

/** How far ahead the Upcoming Deletions list looks (RET-4). */
export const UPCOMING_WINDOW_DAYS = 30;
/** Documents fetched per batch by the daily run. */
const DEFAULT_BATCH_SIZE = 200;
const MAX_HOLD_REASON = 500;

// ─────────────────────────── shared ───────────────────────────

interface DepartmentRow {
  id: string;
  organizationId: string;
  name: string;
  autoDeleteYears: number | null;
  timeZone: string;
}

async function loadDepartment(prisma: PrismaClient, organizationId: string, departmentId: string): Promise<DepartmentRow> {
  const department = await prisma.department.findFirst({
    // Tenant isolation: the department id is always paired with the caller's organization.
    where: { id: departmentId, organizationId },
    select: { id: true, organizationId: true, name: true, autoDeleteYears: true, organization: { select: { timeZone: true } } },
  });
  if (!department) throw new RetentionError(404, "department_not_found", "Department not found.");
  return { ...department, timeZone: department.organization.timeZone };
}

/** Loads the department and refuses anyone without `key` there — resolved by the permission engine,
 *  so a Super Admin (whose administrative baseline excludes the retention keys) is refused too. */
async function requireDepartmentRight(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  key: PermissionKey,
): Promise<DepartmentRow> {
  const department = await loadDepartment(deps.prisma, actor.organizationId, departmentId);
  const resolved = await resolveEffectivePermissions(deps.prisma, actor, departmentId);
  if (resolved.permissions[key] !== true) {
    throw new RetentionError(403, "forbidden", "Only a Department Admin of this department can do this.");
  }
  return department;
}

/** When the next daily run fires, and the date it will treat as "today" in the organization's zone. */
export function nextRun(env: Env, timeZone: string, now = new Date()): { nextRunAt: Date; nextRunDate: IsoDate } {
  const nextRunAt = nextDailyRun(now, env.RETENTION_JOB_TIME, env.RETENTION_JOB_TIME_ZONE);
  return { nextRunAt, nextRunDate: localDate(nextRunAt, timeZone) };
}

/** The instant before which a document's Upload Date makes it due by `date` under `years`. */
function dueByBoundary(date: IsoDate, years: number, timeZone: string): Date {
  return startOfLocalDate(addDays(autoDeleteUploadCutoff(date, years), 1), timeZone);
}

/**
 * Active, unheld documents in a department due on or before `byDate` under a period — what the
 * daily run would move. Counts every document, confidential ones included: a count reveals no name
 * or content (Data Model §8.1), and a destructive confirmation must not under-report.
 */
async function countDueBy(prisma: PrismaClient, department: DepartmentRow, years: number, byDate: IsoDate) {
  const candidates = await prisma.document.findMany({
    where: {
      organizationId: department.organizationId,
      departmentId: department.id,
      status: "active",
      uploadedAt: { lt: dueByBoundary(byDate, years, department.timeZone) },
    },
    select: { id: true, folderId: true },
  });
  if (candidates.length === 0) return 0;
  const holds = await loadHoldIndex(prisma, department.organizationId, department.id);
  return candidates.filter((d) => !holds.isHeld(d)).length;
}

function describePeriod(years: number | null): string {
  return years === null ? "off" : `${years} year${years === 1 ? "" : "s"}`;
}

// ─────────────────────────── the setting (RET-1, RET-2, RET-7) ───────────────────────────

export interface AutoDeleteSetting {
  departmentId: string;
  autoDeleteYears: number | null;
  timeZone: string;
  nextRunAt: Date;
  nextRunDate: IsoDate;
  schedule: { time: string; timeZone: string };
}

function shapeSetting(env: Env, department: DepartmentRow): AutoDeleteSetting {
  return {
    departmentId: department.id,
    autoDeleteYears: department.autoDeleteYears,
    timeZone: department.timeZone,
    ...nextRun(env, department.timeZone),
    schedule: { time: env.RETENTION_JOB_TIME, timeZone: env.RETENTION_JOB_TIME_ZONE },
  };
}

export async function getAutoDeleteSetting(deps: Deps, actor: PermissionActor, departmentId: string) {
  const department = await requireDepartmentRight(deps, actor, departmentId, "retention.manage_auto_delete");
  return shapeSetting(deps.env, department);
}

export interface AutoDeletePreview {
  currentYears: number | null;
  autoDeleteYears: number | null;
  /** Setting a period, or shortening one, needs an explicit confirmation (RET-7). */
  requiresConfirmation: boolean;
  /** Documents the next daily run would move to trash under the proposed period. */
  affectedCount: number;
  nextRunAt: Date;
  nextRunDate: IsoDate;
  message: string;
}

function previewMessage(count: number): string {
  return `${count} document${count === 1 ? "" : "s"} will be moved to Trash at the next daily run.`;
}

async function buildPreview(deps: Deps, department: DepartmentRow, years: number | null): Promise<AutoDeletePreview> {
  const current = department.autoDeleteYears;
  const run = nextRun(deps.env, department.timeZone);
  const requiresConfirmation = years !== null && (current === null || years < current);
  const affectedCount = years === null ? 0 : await countDueBy(deps.prisma, department, years, run.nextRunDate);
  return { currentYears: current, autoDeleteYears: years, requiresConfirmation, affectedCount, ...run, message: previewMessage(affectedCount) };
}

export async function previewAutoDelete(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  years: number | null,
): Promise<AutoDeletePreview> {
  const department = await requireDepartmentRight(deps, actor, departmentId, "retention.manage_auto_delete");
  return buildPreview(deps, department, years);
}

/**
 * Sets, changes or switches off a department's auto-delete period (RET-1). Only the department's own
 * Department Admin may; each department's setting stands alone.
 *
 * Safety (RET-7): setting a period, or shortening one, is refused with `409 confirmation_required`
 * and the preview ("N documents will be moved to Trash at the next daily run") unless the request
 * carries `confirm: true` — nothing is saved until then. Lengthening the period or switching it off
 * can only ever delete fewer documents, so those save straight away. Switching off stops future
 * auto-deletes; it does not bring back anything already permanently removed.
 */
export async function setAutoDeletePeriod(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  input: { autoDeleteYears: number | null; confirm?: boolean },
): Promise<AutoDeleteSetting & { affectedCount: number }> {
  const department = await requireDepartmentRight(deps, actor, departmentId, "retention.manage_auto_delete");
  const years = input.autoDeleteYears;
  if (years !== null && (!Number.isInteger(years) || years < 1 || years > 100)) {
    throw new RetentionError(400, "invalid_period", "The auto-delete period must be a whole number of years from 1 to 100.");
  }
  const current = department.autoDeleteYears;
  if (years === current) return { ...shapeSetting(deps.env, department), affectedCount: 0 };

  const preview = await buildPreview(deps, department, years);
  if (preview.requiresConfirmation && input.confirm !== true) {
    throw new RetentionError(409, "confirmation_required", preview.message, { preview });
  }

  // Conditional on the value the preview was computed against, so two admins saving at once can't
  // confirm against one number and save over another.
  const { count } = await deps.prisma.department.updateMany({
    where: { id: department.id, organizationId: actor.organizationId, autoDeleteYears: current },
    data: { autoDeleteYears: years },
  });
  if (count === 0) {
    throw new RetentionError(409, "setting_changed", "The auto-delete period was changed by someone else. Reload and try again.");
  }

  const verb = current === null ? "set" : years === null ? "switched off" : "changed";
  await logAuditEvent(deps.prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "retention_change",
    departmentId: department.id,
    targetDescription: `Auto-delete period ${verb}: ${describePeriod(current)} → ${describePeriod(years)}`,
  });

  return { ...shapeSetting(deps.env, { ...department, autoDeleteYears: years }), affectedCount: preview.affectedCount };
}

// ─────────────────────────── Upcoming Deletions (RET-4) ───────────────────────────

export interface UpcomingDeletion {
  id: string;
  documentRef: string;
  titleValue: string | null;
  documentType: string;
  folderId: string;
  folderName: string;
  uploadedAt: Date;
  /** The Upload Date on the organization's calendar. */
  uploadDate: IsoDate;
  /** Upload Date + period (29 Feb → 1 Mar in a common year). */
  dueDate: IsoDate;
  /** The daily run that will move it: its due date, or the next run if that date has passed. */
  scheduledDate: IsoDate;
  /** Held documents are listed, clearly marked, and will not be deleted. */
  legalHold: boolean;
  canManageHold: boolean;
}

/**
 * Documents the daily run will auto-delete in the next 30 days, soonest first (RET-4). Documents in
 * confidential folders appear only to members of that folder, and folders a restriction hides are
 * left out — the same query-layer exclusion as every other listing. Held documents are **included
 * and marked** rather than dropped, so placing a hold from this list visibly takes effect.
 */
export async function listUpcomingDeletions(deps: Deps, actor: PermissionActor, departmentId: string, now = new Date()) {
  const department = await requireDepartmentRight(deps, actor, departmentId, "retention.view_upcoming_deletions");
  const years = department.autoDeleteYears;
  const run = nextRun(deps.env, department.timeZone, now);
  const today = localDate(now, department.timeZone);
  const base = { autoDeleteYears: years, windowDays: UPCOMING_WINDOW_DAYS, today, ...run };
  if (years === null) return { ...base, items: [] as UpcomingDeletion[] };

  const hidden = await unviewableFolderIdsToExclude(deps.prisma, actor, departmentId);
  const documents = await deps.prisma.document.findMany({
    where: {
      organizationId: actor.organizationId,
      departmentId,
      status: "active",
      uploadedAt: { lt: dueByBoundary(addDays(today, UPCOMING_WINDOW_DAYS), years, department.timeZone) },
      folderId: { notIn: hidden.length > 0 ? hidden : ["__none__"] },
    },
    include: { documentType: { select: { name: true } }, folder: { select: { name: true } } },
  });

  const holds = await loadHoldIndex(deps.prisma, actor.organizationId, departmentId);
  const authority = new Map<string, boolean>();
  for (const folderId of new Set(documents.map((d) => d.folderId))) {
    authority.set(folderId, (await legalHoldAuthority(deps.prisma, actor, departmentId, folderId)) === "allowed");
  }

  const items = documents.map<UpcomingDeletion>((d) => {
    const uploadDate = localDate(d.uploadedAt, department.timeZone);
    const dueDate = autoDeleteDueDate(uploadDate, years);
    return {
      id: d.id,
      documentRef: d.documentRef,
      titleValue: d.titleValue,
      documentType: d.documentType.name,
      folderId: d.folderId,
      folderName: d.folder.name,
      uploadedAt: d.uploadedAt,
      uploadDate,
      dueDate,
      scheduledDate: dueDate < run.nextRunDate ? run.nextRunDate : dueDate,
      legalHold: holds.isHeld(d),
      canManageHold: authority.get(d.folderId) === true,
    };
  });
  items.sort(
    (a, b) =>
      a.scheduledDate.localeCompare(b.scheduledDate) ||
      a.dueDate.localeCompare(b.dueDate) ||
      a.documentRef.localeCompare(b.documentRef),
  );
  return { ...base, items };
}

// ─────────────────────────── Legal Hold (RET-5, RET-6) ───────────────────────────

export interface HoldView {
  id: string;
  scope: "document" | "folder";
  documentId: string | null;
  documentRef: string | null;
  titleValue: string | null;
  folderId: string | null;
  folderName: string | null;
  reason: string;
  placedByName: string;
  placedAt: Date;
}

function cleanReason(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new RetentionError(400, "reason_required", "A reason is required to place a Legal Hold.");
  if (trimmed.length > MAX_HOLD_REASON) {
    throw new RetentionError(400, "reason_too_long", `Keep the reason under ${MAX_HOLD_REASON} characters.`);
  }
  return trimmed;
}

function refuse(authority: "forbidden" | "not_found", what: string): never {
  if (authority === "not_found") throw new RetentionError(404, `${what}_not_found`, `${what === "document" ? "Document" : "Folder"} not found.`);
  throw new RetentionError(
    403,
    "forbidden",
    "Only a Department Admin can place or remove a Legal Hold here — or, in a confidential folder, its Owner.",
  );
}

/** Places a Legal Hold on one document (in trash or not). A reason is mandatory. */
export async function placeDocumentHold(deps: Deps, actor: PermissionActor, documentId: string, reason: string | undefined) {
  const text = cleanReason(reason);
  const { prisma } = deps;
  const document = await prisma.document.findFirst({
    where: { id: documentId, organizationId: actor.organizationId },
    select: { id: true, departmentId: true, folderId: true, documentRef: true },
  });
  if (!document) throw new RetentionError(404, "document_not_found", "Document not found.");
  const authority = await legalHoldAuthority(prisma, actor, document.departmentId, document.folderId);
  if (authority !== "allowed") refuse(authority, "document");

  const existing = await prisma.legalHold.findFirst({
    where: { organizationId: actor.organizationId, documentId: document.id, removedAt: null },
    select: { id: true },
  });
  if (existing) throw new RetentionError(409, "already_held", "This document already has a Legal Hold.");

  const hold = await prisma.legalHold.create({
    data: {
      organizationId: actor.organizationId,
      departmentId: document.departmentId,
      documentId: document.id,
      reason: text,
      placedByUserId: actor.userId,
    },
  });
  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "legal_hold_placed",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Legal Hold placed on ${document.documentRef} — reason: ${text}`,
  });
  return { id: hold.id, documentId: document.id, reason: hold.reason, placedAt: hold.placedAt };
}

/** Places a Legal Hold on a folder: it covers the folder, every subfolder, and documents added later. */
export async function placeFolderHold(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  folderId: string,
  reason: string | undefined,
) {
  const text = cleanReason(reason);
  const { prisma } = deps;
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, organizationId: actor.organizationId, departmentId },
    select: { id: true, name: true, departmentId: true, isConfidential: true },
  });
  if (!folder) throw new RetentionError(404, "folder_not_found", "Folder not found.");
  const authority = await legalHoldAuthority(prisma, actor, folder.departmentId, folder.id);
  if (authority !== "allowed") refuse(authority, "folder");

  const existing = await prisma.legalHold.findFirst({
    where: { organizationId: actor.organizationId, folderId: folder.id, removedAt: null },
    select: { id: true },
  });
  if (existing) throw new RetentionError(409, "already_held", "This folder already has a Legal Hold.");

  const hold = await prisma.legalHold.create({
    data: {
      organizationId: actor.organizationId,
      departmentId: folder.departmentId,
      folderId: folder.id,
      reason: text,
      placedByUserId: actor.userId,
    },
  });
  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "legal_hold_placed",
    departmentId: folder.departmentId,
    targetDescription: `Legal Hold placed on folder "${folder.name}" and everything in it — reason: ${text}`,
    isConfidential: folder.isConfidential,
  });
  return { id: hold.id, folderId: folder.id, reason: hold.reason, placedAt: hold.placedAt };
}

/**
 * Removes a hold, recording who removed it and when. It does not delete or move anything itself: an
 * already-expired document is picked up by the **next** daily run, never immediately (RET-6).
 */
export async function removeHold(deps: Deps, actor: PermissionActor, holdId: string) {
  const { prisma } = deps;
  const hold = await prisma.legalHold.findFirst({
    where: { id: holdId, organizationId: actor.organizationId, removedAt: null },
    include: {
      document: { select: { id: true, folderId: true, documentRef: true } },
      folder: { select: { id: true, name: true, isConfidential: true } },
    },
  });
  if (!hold) throw new RetentionError(404, "hold_not_found", "Legal Hold not found.");
  const targetFolderId = hold.folder?.id ?? hold.document?.folderId;
  if (!targetFolderId) throw new RetentionError(404, "hold_not_found", "Legal Hold not found.");

  const authority = await legalHoldAuthority(prisma, actor, hold.departmentId, targetFolderId);
  // A hold on something the caller can't see is as invisible as the thing itself.
  if (authority === "not_found") throw new RetentionError(404, "hold_not_found", "Legal Hold not found.");
  if (authority !== "allowed") refuse(authority, "folder");

  const { count } = await prisma.legalHold.updateMany({
    where: { id: hold.id, organizationId: actor.organizationId, removedAt: null },
    data: { removedAt: new Date(), removedByUserId: actor.userId },
  });
  if (count === 0) throw new RetentionError(409, "already_removed", "This Legal Hold has already been removed.");

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "legal_hold_removed",
    documentId: hold.document?.id,
    departmentId: hold.departmentId,
    targetDescription: hold.document
      ? `Legal Hold removed from ${hold.document.documentRef} (reason was: ${hold.reason})`
      : `Legal Hold removed from folder "${hold.folder!.name}" (reason was: ${hold.reason})`,
    isConfidential: hold.folder?.isConfidential === true,
  });
  return { id: hold.id, removed: true };
}

/** A department's active holds, for the Department Admin's Retention screen. Holds on documents or
 *  folders the caller can't see (confidential vaults they aren't named on) are left out. */
export async function listHolds(deps: Deps, actor: PermissionActor, departmentId: string): Promise<HoldView[]> {
  await requireDepartmentRight(deps, actor, departmentId, "retention.manage_legal_hold");
  const hidden = new Set(await unviewableFolderIdsToExclude(deps.prisma, actor, departmentId));
  const holds = await deps.prisma.legalHold.findMany({
    where: { organizationId: actor.organizationId, departmentId, removedAt: null },
    include: {
      document: { select: { id: true, documentRef: true, titleValue: true, folderId: true } },
      folder: { select: { id: true, name: true } },
      placedBy: { select: { fullName: true } },
    },
    orderBy: { placedAt: "desc" },
  });
  return holds
    .filter((h) => !hidden.has(h.folder?.id ?? h.document?.folderId ?? ""))
    .map((h) => ({
      id: h.id,
      scope: h.documentId ? ("document" as const) : ("folder" as const),
      documentId: h.document?.id ?? null,
      documentRef: h.document?.documentRef ?? null,
      titleValue: h.document?.titleValue ?? null,
      folderId: h.folder?.id ?? null,
      folderName: h.folder?.name ?? null,
      reason: h.reason,
      placedByName: h.placedBy.fullName,
      placedAt: h.placedAt,
    }));
}

// ─────────────────────────── the daily run (RET-3) ───────────────────────────

export interface RunOptions {
  /** The instant the run treats as "now" — injectable so tests can pin boundaries. */
  now?: Date;
  batchSize?: number;
  /** Limit the run to these departments (tests). Production runs every department. */
  departmentIds?: string[];
}

export interface RunFailure {
  documentId: string;
  documentRef: string;
  message: string;
}

export interface AutoDeleteResult {
  departments: number;
  moved: number;
  skippedHeld: number;
  /** Found already in trash by the time we reached it (a person, or a concurrent run, got there first). */
  alreadyInTrash: number;
  failed: RunFailure[];
}

/**
 * Moves every expired document to trash: for each department with a period set, active documents
 * whose Upload Date + period is on or before today (in the organization's time zone), skipping any
 * under a Legal Hold directly or through a folder. Uses the ordinary soft-delete path, with the
 * reason "Auto-deleted - retention period ended" and the System as actor, one audit record each.
 *
 * Safe to run twice on the same day: a moved document is no longer active, and the move itself is
 * conditional on that, so nothing is processed twice. Works in batches, and one failing document is
 * logged and counted without stopping the rest. Every query carries the department's organization —
 * the run never reaches across tenants.
 */
export async function runAutoDelete(deps: { prisma: PrismaClient }, options: RunOptions = {}): Promise<AutoDeleteResult> {
  const { prisma } = deps;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: AutoDeleteResult = { departments: 0, moved: 0, skippedHeld: 0, alreadyInTrash: 0, failed: [] };

  const departments = await prisma.department.findMany({
    where: {
      autoDeleteYears: { not: null },
      ...(options.departmentIds ? { id: { in: options.departmentIds } } : {}),
    },
    select: { id: true, organizationId: true, autoDeleteYears: true, organization: { select: { timeZone: true } } },
    orderBy: { id: "asc" },
  });

  for (const department of departments) {
    result.departments++;
    const years = department.autoDeleteYears!;
    const timeZone = department.organization.timeZone;
    const today = localDate(now, timeZone);
    const boundary = dueByBoundary(today, years, timeZone);
    const holds = await loadHoldIndex(prisma, department.organizationId, department.id);

    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.document.findMany({
        where: {
          organizationId: department.organizationId,
          departmentId: department.id,
          status: "active",
          uploadedAt: { lt: boundary },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: { id: true, organizationId: true, departmentId: true, folderId: true, documentRef: true, uploadedAt: true },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.id;

      for (const document of batch) {
        if (holds.isHeld(document)) {
          result.skippedHeld++;
          continue;
        }
        try {
          const uploadDate = localDate(document.uploadedAt, timeZone);
          const moved = await moveDocumentToTrash(prisma, document, {
            actorUserId: SYSTEM_ACTOR,
            source: "auto_delete",
            reason: AUTO_DELETE_TRASH_REASON,
            auditAction: "auto_delete",
            auditDescription: `${AUTO_DELETE_TRASH_REASON} (${describePeriod(years)} from upload on ${uploadDate}): ${document.documentRef}`,
          });
          if (moved) result.moved++;
          else result.alreadyInTrash++;
        } catch (err) {
          // A hold placed after the index was built is still honoured — the move re-checks it.
          if (err instanceof DocumentError && err.code === "legal_hold") {
            result.skippedHeld++;
            continue;
          }
          recordFailure(result.failed, document, err, "auto-delete");
        }
      }
    }
  }
  return result;
}

export interface TrashPurgeResult {
  purged: number;
  skippedHeld: number;
  failed: RunFailure[];
}

/**
 * The automatic trash purge: permanently removes every item that has been in trash for the full
 * trash window (TRASH_RETENTION_DAYS, default 30), whoever deleted it — never one under a Legal Hold.
 * The System is recorded as actor, one `purge` audit record per document; the records outlive the
 * document. Batched, tenant-scoped per document, and one failure doesn't stop the rest.
 */
export async function runTrashPurge(deps: { prisma: PrismaClient; env: Env }, options: RunOptions = {}): Promise<TrashPurgeResult> {
  const { prisma } = deps;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result: TrashPurgeResult = { purged: 0, skippedHeld: 0, failed: [] };
  const holdIndexes = new Map<string, HoldIndex>();

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.document.findMany({
      where: {
        status: "in_trash",
        deletedAt: { lte: cutoff },
        ...(options.departmentIds ? { departmentId: { in: options.departmentIds } } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, organizationId: true, departmentId: true, folderId: true, documentRef: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const document of batch) {
      const key = `${document.organizationId}:${document.departmentId}`;
      let holds = holdIndexes.get(key);
      if (!holds) {
        holds = await loadHoldIndex(prisma, document.organizationId, document.departmentId);
        holdIndexes.set(key, holds);
      }
      if (holds.isHeld(document)) {
        result.skippedHeld++;
        continue;
      }
      try {
        await destroyTrashedDocument(deps, document, {
          actorUserId: SYSTEM_ACTOR,
          auditAction: "purge",
          auditDescription: `Permanently deleted - trash window of ${TRASH_RETENTION_DAYS} days ended: ${document.documentRef}`,
        });
        result.purged++;
      } catch (err) {
        if (err instanceof DocumentError && err.code === "legal_hold") {
          result.skippedHeld++;
          continue;
        }
        recordFailure(result.failed, document, err, "trash purge");
      }
    }
  }
  return result;
}

function recordFailure(failed: RunFailure[], document: { id: string; documentRef: string }, err: unknown, stage: string) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[retention] ${stage} failed for document ${document.id} (${document.documentRef}): ${message}`);
  failed.push({ documentId: document.id, documentRef: document.documentRef, message });
}

/** The whole daily run: auto-delete into trash, then the automatic trash purge. */
export async function runDailyRetention(deps: { prisma: PrismaClient; env: Env }, options: RunOptions = {}) {
  const autoDelete = await runAutoDelete(deps, options);
  const trashPurge = await runTrashPurge(deps, options);
  return { autoDelete, trashPurge };
}
