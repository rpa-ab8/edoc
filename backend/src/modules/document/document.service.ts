import type { Prisma, PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env.js";
import { logAuditEvent } from "../../lib/audit.js";
import { generateDocumentRef } from "../../lib/document-ref.js";
import { refreshDocumentSearchVector } from "../../lib/search-vector.js";
import { getActiveStorageDriver } from "../storage/storage.service.js";
import {
  unviewableFolderIdsToExclude,
  resolveEffectivePermissions,
  type PermissionActor,
} from "../../lib/effective-permissions.js";
import { resolveSharedAccess } from "../../lib/share-access.js";
import {
  emptyPermissionMap,
  hasDepartmentAdminCapability,
  type PermissionKey,
  type PermissionMap,
} from "../../lib/permissions.js";

export class DocumentError extends Error {
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

export interface VersionFileInput {
  storageRef: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksum?: string | null;
  ocrStatus?: "pending" | "done" | "failed";
  ocrText?: string | null;
}

export interface SubmittedFieldValue {
  fieldDefId: string;
  value: string;
}

/**
 * The file bytes never touch this module. Module 6 (Upload) stores the file through the storage
 * abstraction and passes the resulting opaque `storageRef` in — this module only records that a
 * version exists, so it stays storage-agnostic and swapping the backend is a driver swap, not a
 * change here (CLAUDE.md hard rule).
 */
export interface CreateDocumentInput {
  folderId: string;
  documentTypeId: string;
  fieldValues: SubmittedFieldValue[];
  file: VersionFileInput;
  changeNote?: string | null;
  /**
   * Upload's "never block" mode (UPL-5): save even when required fields are missing, so a file is
   * never rejected for want of metadata. Field *types* and options are still validated — only the
   * required-presence check is skipped. The document then surfaces in the needs-details queue
   * (`listNeedsDetails`) until completed. Defaults to false so direct/tested creates stay strict.
   */
  allowIncomplete?: boolean;
}

// ─────────────────────────── field-value validation ───────────────────────────

type FieldDefRow = {
  id: string;
  label: string;
  fieldType: "text" | "id" | "dropdown" | "date" | "number" | "person";
  isRequired: boolean;
  isTitle: boolean;
  options: unknown;
};

function dropdownOptions(field: FieldDefRow): string[] {
  return Array.isArray(field.options) ? field.options.map((o) => String(o)) : [];
}

/**
 * Validates the submitted values against the document type's field definitions and returns the
 * rows to persist plus the derived title. The same "define once" field metadata that drives the
 * upload form and the filter panel drives this check — a field can't be entered that the type
 * doesn't define, a required field can't be left blank, and a dropdown can't hold an off-list value.
 */
function validateFieldValues(
  fields: FieldDefRow[],
  submitted: SubmittedFieldValue[],
  allowIncomplete = false,
): { rows: { fieldDefId: string; value: string }[]; titleValue: string | null } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const rows: { fieldDefId: string; value: string }[] = [];

  for (const entry of submitted) {
    const field = byId.get(entry.fieldDefId);
    if (!field) {
      throw new DocumentError(400, "unknown_field", "A field was supplied that this document type doesn't define.");
    }
    if (seen.has(entry.fieldDefId)) {
      throw new DocumentError(400, "duplicate_field", `The field "${field.label}" was given more than once.`);
    }
    seen.add(entry.fieldDefId);

    const value = entry.value.trim();
    if (value === "") continue; // an empty value is simply an absent one — required-ness is checked below

    if (field.fieldType === "dropdown" && !dropdownOptions(field).includes(value)) {
      throw new DocumentError(400, "invalid_option", `"${value}" is not an option for "${field.label}".`);
    }
    if (field.fieldType === "number" && Number.isNaN(Number(value))) {
      throw new DocumentError(400, "invalid_number", `"${field.label}" must be a number.`);
    }
    if (field.fieldType === "date" && Number.isNaN(Date.parse(value))) {
      throw new DocumentError(400, "invalid_date", `"${field.label}" must be a valid date.`);
    }

    rows.push({ fieldDefId: field.id, value });
  }

  // Required fields must be present with a non-empty value — unless the caller is in "never block"
  // upload mode (UPL-5), where a missing required field defers to the needs-details queue instead
  // of rejecting the file.
  if (!allowIncomplete) {
    const provided = new Set(rows.map((r) => r.fieldDefId));
    for (const field of fields) {
      if (field.isRequired && !provided.has(field.id)) {
        throw new DocumentError(400, "missing_required_field", `"${field.label}" is required.`);
      }
    }
  }

  const titleField = fields.find((f) => f.isTitle);
  const titleValue = titleField
    ? (rows.find((r) => r.fieldDefId === titleField.id)?.value ?? null)
    : null;

  return { rows, titleValue };
}

// ─────────────────────────── permission-scoped loads ───────────────────────────

const documentInclude = {
  documentType: { select: { id: true, name: true, idCode: true } },
  currentVersion: true,
  versions: {
    orderBy: { versionNumber: "asc" as const },
    include: { uploadedBy: { select: { id: true, fullName: true, email: true } } },
  },
  fieldValues: { include: { fieldDef: true } },
} satisfies Prisma.DocumentInclude;

type LoadedDocument = Prisma.DocumentGetPayload<{ include: typeof documentInclude }>;

/** Loads a document with the full detail include, tenant-scoped, without any permission check. */
async function loadRawDocument(deps: Deps, organizationId: string, documentId: string): Promise<LoadedDocument> {
  const document = await deps.prisma.document.findFirst({
    where: { id: documentId, organizationId },
    include: documentInclude,
  });
  if (!document) throw new DocumentError(404, "document_not_found", "Document not found.");
  return document;
}

/**
 * The permission map that actually governs a document for an actor: the role/folder chain first,
 * and — only for someone that chain does not already admit — an active share by reference as a
 * fallback (Module 9).
 *
 * A share confers a strict read-only floor: view, preview, version history, and download only where
 * the share allows it. It never grants edit / delete / new-version / re-share — the home department
 * keeps those (Feature Spec §7.2). A **confidential** document is never reachable by share: the
 * named list is its only door (§11), so the fallback is skipped when the folder is confidential.
 */
async function resolveDocumentPermissions(
  deps: Deps,
  actor: PermissionActor,
  document: { id: string; organizationId: string; departmentId: string; folderId: string },
): Promise<{ map: PermissionMap; isConfidential: boolean; viaShare: boolean }> {
  const resolved = await resolveEffectivePermissions(
    deps.prisma,
    actor,
    document.departmentId,
    document.folderId,
  );
  if (resolved.permissions["documents.view"] === true || resolved.isConfidential) {
    return { map: resolved.permissions, isConfidential: resolved.isConfidential, viaShare: false };
  }

  const shared = await resolveSharedAccess(deps.prisma, actor, document);
  if (!shared) {
    return { map: resolved.permissions, isConfidential: false, viaShare: false };
  }

  // A view-only share is genuinely view-only: the document ID, its metadata and an inline preview —
  // nothing else. No version history, no activity feed, no re-share, no new version, and download
  // only when the share explicitly grants it. The home department keeps everything else.
  const map = emptyPermissionMap();
  map["documents.view"] = true;
  map["documents.preview"] = true;
  if (shared.permission === "download") map["documents.download"] = true;
  return { map, isConfidential: false, viaShare: true };
}

/**
 * Loads a document by identity and enforces access through the permission engine (with the share
 * fallback above), resolved for the document's *own* folder so a folder override or a confidential
 * boundary is honoured. Access is identity-based (Feature Spec §8, "identity over location") — the
 * viewer navigates by document ID, not by folder path.
 *
 * A document the actor may not view is reported as `document_not_found`, never `forbidden`: a
 * confidential document is invisible entirely, so a distinct error would confirm it exists.
 */
async function loadDocumentForActor(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
  actionKey: PermissionKey,
): Promise<LoadedDocument> {
  const document = await deps.prisma.document.findFirst({
    where: { id: documentId, organizationId: actor.organizationId },
    include: documentInclude,
  });
  if (!document) {
    throw new DocumentError(404, "document_not_found", "Document not found.");
  }

  const { map } = await resolveDocumentPermissions(deps, actor, document);

  if (map["documents.view"] !== true) {
    throw new DocumentError(404, "document_not_found", "Document not found.");
  }
  // The actor can see the document but may still lack the specific action (restore, edit): that is
  // a real 403 — the document's existence is no longer a secret from them.
  if (map[actionKey] !== true) {
    throw new DocumentError(403, "forbidden", "You don't have access to this action.");
  }

  return document;
}

function shapeDocument(document: LoadedDocument) {
  return {
    id: document.id,
    documentRef: document.documentRef,
    titleValue: document.titleValue,
    departmentId: document.departmentId,
    folderId: document.folderId,
    status: document.status,
    documentType: document.documentType,
    currentVersionId: document.currentVersionId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    fieldValues: document.fieldValues.map((fv) => ({
      fieldDefId: fv.fieldDefId,
      label: fv.fieldDef.label,
      fieldType: fv.fieldDef.fieldType,
      value: fv.value,
    })),
    versions: document.versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      fileName: v.fileName,
      fileSize: v.fileSize,
      mimeType: v.mimeType,
      ocrStatus: v.ocrStatus,
      changeNote: v.changeNote,
      isCurrent: v.id === document.currentVersionId,
      uploadedBy: v.uploadedBy,
      createdAt: v.createdAt,
    })),
  };
}

// ─────────────────────────── create ───────────────────────────

/**
 * Creates a document, its first version, and its field values in one transaction, minting the
 * immutable `document_ref` inside that same transaction so a rolled-back create never leaves a
 * gap in the sequence. Permission (`documents.upload`) is enforced at the route; this enforces the
 * domain rules and tenant isolation. Called by Module 6 once the file is stored.
 */
export async function createDocument(deps: Deps, actor: PermissionActor, input: CreateDocumentInput) {
  const { prisma } = deps;

  const folder = await prisma.folder.findFirst({
    where: { id: input.folderId, organizationId: actor.organizationId },
    select: { id: true, departmentId: true, isConfidential: true },
  });
  if (!folder) throw new DocumentError(404, "folder_not_found", "Folder not found.");

  const documentType = await prisma.documentType.findFirst({
    where: { id: input.documentTypeId, departmentId: folder.departmentId },
    include: { fields: true, department: { select: { idPrefix: true } } },
  });
  if (!documentType) {
    // Either the type doesn't exist or it belongs to a different department than the folder — both
    // mean the file can't be filed here.
    throw new DocumentError(400, "document_type_mismatch", "That document type doesn't belong to this folder's department.");
  }

  const { rows, titleValue } = validateFieldValues(
    documentType.fields,
    input.fieldValues,
    input.allowIncomplete ?? false,
  );
  const year = new Date().getFullYear();

  const created = await prisma.$transaction(async (tx) => {
    const documentRef = await generateDocumentRef(tx, {
      organizationId: actor.organizationId,
      departmentId: folder.departmentId,
      documentTypeId: documentType.id,
      idPrefix: documentType.department.idPrefix,
      idCode: documentType.idCode,
      year,
    });

    const document = await tx.document.create({
      data: {
        organizationId: actor.organizationId,
        departmentId: folder.departmentId,
        folderId: folder.id,
        documentTypeId: documentType.id,
        documentRef,
        titleValue,
        status: "active",
      },
    });

    const version = await tx.version.create({
      data: {
        organizationId: actor.organizationId,
        documentId: document.id,
        versionNumber: 1,
        storageRef: input.file.storageRef,
        fileName: input.file.fileName,
        fileSize: input.file.fileSize,
        mimeType: input.file.mimeType,
        checksum: input.file.checksum ?? null,
        ocrStatus: input.file.ocrStatus ?? "pending",
        ocrText: input.file.ocrText ?? null,
        changeNote: input.changeNote ?? null,
        uploadedByUserId: actor.userId,
      },
    });

    await tx.document.update({
      where: { id: document.id },
      data: { currentVersionId: version.id },
    });

    if (rows.length > 0) {
      await tx.fieldValue.createMany({
        data: rows.map((r) => ({ documentId: document.id, fieldDefId: r.fieldDefId, value: r.value })),
      });
    }

    return document;
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "upload",
    documentId: created.id,
    departmentId: folder.departmentId,
    targetDescription: `Document created: ${created.documentRef}`,
    isConfidential: folder.isConfidential,
  });

  await refreshDocumentSearchVector(prisma, created.id);

  // Return without re-checking `documents.view`: the route already enforced `documents.upload`,
  // and a role may hold upload without view — re-gating here would wrongly hide what was just made.
  return shapeDocument(await loadRawDocument(deps, actor.organizationId, created.id));
}

// ─────────────────────────── new version ───────────────────────────

/**
 * Files a new version of an existing document. Never overwrites: a new `version` row is added and
 * becomes current, the prior version drops into history, and the document's ID and metadata carry
 * over unchanged (DOC-4). Gated by `documents.upload_version`, distinct from first-time upload.
 * Called by Module 6 once the new file is stored.
 */
export async function addVersion(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
  input: { file: VersionFileInput; changeNote?: string | null },
) {
  const { prisma } = deps;
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.upload_version");

  if (document.status !== "active") {
    throw new DocumentError(409, "document_in_trash", "Restore this document from trash before adding a version.");
  }

  const nextNumber = Math.max(0, ...document.versions.map((v) => v.versionNumber)) + 1;

  await prisma.$transaction(async (tx) => {
    const version = await tx.version.create({
      data: {
        organizationId: actor.organizationId,
        documentId: document.id,
        versionNumber: nextNumber,
        storageRef: input.file.storageRef,
        fileName: input.file.fileName,
        fileSize: input.file.fileSize,
        mimeType: input.file.mimeType,
        checksum: input.file.checksum ?? null,
        ocrStatus: input.file.ocrStatus ?? "pending",
        ocrText: input.file.ocrText ?? null,
        changeNote: input.changeNote ?? null,
        uploadedByUserId: actor.userId,
      },
    });
    await tx.document.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "upload",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `New version uploaded (v${nextNumber}): ${document.documentRef}`,
  });

  // The current version (hence filename, and pending OCR text) changed — re-index.
  await refreshDocumentSearchVector(prisma, document.id);

  return shapeDocument(await loadRawDocument(deps, actor.organizationId, document.id));
}

// ─────────────────────────── restore a version ───────────────────────────

/**
 * Restores an earlier version by copying its file forward as a new current version (DOC-5). The
 * intervening versions are never deleted — the chain only grows. No new file is uploaded, so this
 * is fully self-contained (it needs no storage write); Module 6 is only needed for uploads that
 * bring new bytes. Gated by `documents.upload_version` — the same permission that governs versions.
 */
export async function restoreVersion(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
  versionId: string,
) {
  const { prisma } = deps;
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.upload_version");

  if (document.status !== "active") {
    throw new DocumentError(409, "document_in_trash", "Restore this document from trash first.");
  }

  const source = document.versions.find((v) => v.id === versionId);
  if (!source) {
    throw new DocumentError(404, "version_not_found", "That version doesn't belong to this document.");
  }
  if (document.currentVersionId === versionId) {
    throw new DocumentError(409, "already_current", "That version is already the current one.");
  }

  const nextNumber = Math.max(0, ...document.versions.map((v) => v.versionNumber)) + 1;

  await prisma.$transaction(async (tx) => {
    const version = await tx.version.create({
      data: {
        organizationId: actor.organizationId,
        documentId: document.id,
        versionNumber: nextNumber,
        // The same file carried forward — the storage_ref is reused, not re-uploaded, so both
        // version rows reference the identical stored object.
        storageRef: source.storageRef,
        fileName: source.fileName,
        fileSize: source.fileSize,
        mimeType: source.mimeType,
        checksum: source.checksum,
        ocrStatus: source.ocrStatus,
        ocrText: source.ocrText,
        changeNote: `Restored from v${source.versionNumber}`,
        uploadedByUserId: actor.userId,
      },
    });
    await tx.document.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "restore",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Restored v${source.versionNumber} as v${nextNumber}: ${document.documentRef}`,
  });

  await refreshDocumentSearchVector(prisma, document.id);

  return shapeDocument(await loadRawDocument(deps, actor.organizationId, document.id));
}

// ─────────────────────────── edit metadata ───────────────────────────

/**
 * Replaces the document's field values (and re-derives the title). Gated by
 * `documents.edit_metadata`. The document ID never changes — this touches metadata only.
 */
export async function editMetadata(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
  fieldValues: SubmittedFieldValue[],
) {
  const { prisma } = deps;
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.edit_metadata");

  const fields = await prisma.fieldDef.findMany({ where: { documentTypeId: document.documentTypeId } });
  const { rows, titleValue } = validateFieldValues(fields as FieldDefRow[], fieldValues);

  await prisma.$transaction(async (tx) => {
    await tx.fieldValue.deleteMany({ where: { documentId: document.id } });
    if (rows.length > 0) {
      await tx.fieldValue.createMany({
        data: rows.map((r) => ({ documentId: document.id, fieldDefId: r.fieldDefId, value: r.value })),
      });
    }
    await tx.document.update({ where: { id: document.id }, data: { titleValue } });
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "edit",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Metadata edited: ${document.documentRef}`,
  });

  // Field values (and the derived title) changed — re-index so search reflects the edit.
  await refreshDocumentSearchVector(prisma, document.id);

  return shapeDocument(await loadRawDocument(deps, actor.organizationId, document.id));
}

// ─────────────────────────── read ───────────────────────────

/** Full document detail for the viewer — metadata, version history, the caller's own permissions
 *  (so the viewer renders a permission-driven toolbar, VUE-5), and a short activity feed (VUE-4).
 *  Opening the viewer records a `view` event. */
export async function getDocument(deps: Deps, actor: PermissionActor, documentId: string) {
  const { prisma } = deps;
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.view");
  const resolved = await resolveDocumentPermissions(deps, actor, document);

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "view",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Viewed: ${document.documentRef}`,
    isConfidential: resolved.isConfidential,
  });

  return {
    ...shapeDocument(document),
    permissions: resolved.map,
    activity: await loadActivity(deps, actor.organizationId, document.id),
  };
}

interface ActivityEntry {
  id: string;
  action: string;
  actorName: string;
  description: string | null;
  occurredAt: Date;
}

async function loadActivity(deps: Deps, organizationId: string, documentId: string): Promise<ActivityEntry[]> {
  const events = await deps.prisma.auditEvent.findMany({
    where: { organizationId, documentId },
    orderBy: { occurredAt: "desc" },
    take: 50,
    include: { actor: { select: { fullName: true } } },
  });
  return events.map((e) => ({
    id: e.id,
    action: e.action,
    actorName: e.actor.fullName,
    description: e.targetDescription,
    occurredAt: e.occurredAt,
  }));
}

/** The per-document activity feed, on its own so the viewer can refresh it after an action without
 *  re-logging a view. Requires `documents.view` (which, for a confidential folder, means membership
 *  — so the feed stays member-only, VUE-4). */
export async function getDocumentActivity(deps: Deps, actor: PermissionActor, documentId: string) {
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.view");
  return loadActivity(deps, actor.organizationId, document.id);
}

/**
 * Serves a version's bytes for in-browser preview or download (VUE-1/VUE-5). Enforces `documents.view`
 * to see the document at all, then `documents.preview` (inline) or `documents.download` (attachment).
 * A download is audit-logged; a preview is not (the open was already logged by `getDocument`). Bytes
 * come through the storage abstraction, never a raw path.
 */
export async function getDocumentFile(
  deps: { prisma: PrismaClient; env: Env },
  actor: PermissionActor,
  documentId: string,
  versionId: string | undefined,
  mode: "preview" | "download",
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const actionKey: PermissionKey = mode === "download" ? "documents.download" : "documents.preview";
  const document = await loadDocumentForActor(deps, actor, documentId, actionKey);

  const version = versionId
    ? document.versions.find((v) => v.id === versionId)
    : document.versions.find((v) => v.id === document.currentVersionId);
  if (!version) {
    throw new DocumentError(404, "version_not_found", "That version doesn't belong to this document.");
  }

  const driver = await getActiveStorageDriver(deps, actor.organizationId);
  const buffer = await driver.get(version.storageRef);

  if (mode === "download") {
    await logAuditEvent(deps.prisma, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "download",
      documentId: document.id,
      departmentId: document.departmentId,
      targetDescription: `Downloaded ${version.fileName} (v${version.versionNumber}): ${document.documentRef}`,
    });
  }

  return { buffer, mimeType: version.mimeType, fileName: version.fileName };
}

/**
 * Exact-match ID lookup (DOC-3): pasting a document ID jumps straight to the document rather than
 * running a search. Returns just enough to navigate. A document the actor may not view resolves to
 * `document_not_found`, identical to a genuinely unknown ID — no existence leak.
 */
export async function lookupByRef(deps: Deps, actor: PermissionActor, documentRef: string) {
  const { prisma } = deps;
  const document = await prisma.document.findFirst({
    where: { organizationId: actor.organizationId, documentRef: documentRef.trim() },
    select: { id: true, departmentId: true, folderId: true },
  });
  if (!document) throw new DocumentError(404, "document_not_found", "No document has that ID.");

  const resolved = await resolveEffectivePermissions(prisma, actor, document.departmentId, document.folderId);
  if (resolved.permissions["documents.view"] !== true) {
    throw new DocumentError(404, "document_not_found", "No document has that ID.");
  }

  return { documentId: document.id, departmentId: document.departmentId, folderId: document.folderId };
}

/**
 * The active documents directly in one folder, for the workspace listing. Permission is enforced
 * at the route (`documents.view`, folder-scoped), which also handles the confidential boundary —
 * a folder the actor can't see never reaches this call.
 */
export async function listFolderDocuments(deps: Deps, actor: PermissionActor, folderId: string) {
  const { prisma } = deps;
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!folder) throw new DocumentError(404, "folder_not_found", "Folder not found.");

  const documents = await prisma.document.findMany({
    where: { organizationId: actor.organizationId, folderId, status: "active" },
    orderBy: { updatedAt: "desc" },
    include: {
      documentType: { select: { name: true } },
      currentVersion: { select: { fileName: true, fileSize: true, mimeType: true, createdAt: true } },
    },
  });

  return documents.map((d) => ({
    id: d.id,
    documentRef: d.documentRef,
    titleValue: d.titleValue,
    documentType: d.documentType.name,
    fileName: d.currentVersion?.fileName ?? null,
    fileSize: d.currentVersion?.fileSize ?? null,
    mimeType: d.currentVersion?.mimeType ?? null,
    updatedAt: d.updatedAt,
  }));
}

export interface DuplicateMatch {
  documentId: string;
  documentRef: string;
  titleValue: string | null;
  folderId: string;
  fileName: string;
}

/**
 * Documents in a department that already hold a version with this checksum and that the actor may
 * view — the basis for duplicate-on-upload (UPL-4: offer "add as new version"). Scoped to the
 * department the upload is happening in; a match the uploader can't reach isn't offered (and its
 * existence isn't leaked). Returns at most a handful — one entry per matching document.
 */
export async function findDuplicatesInDepartment(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
  checksum: string,
): Promise<DuplicateMatch[]> {
  const { prisma } = deps;
  const versions = await prisma.version.findMany({
    where: {
      organizationId: actor.organizationId,
      checksum,
      document: { departmentId, status: "active" },
    },
    select: {
      fileName: true,
      document: { select: { id: true, documentRef: true, titleValue: true, folderId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const seen = new Set<string>();
  const matches: DuplicateMatch[] = [];
  for (const v of versions) {
    const doc = v.document;
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    const resolved = await resolveEffectivePermissions(prisma, actor, departmentId, doc.folderId);
    if (resolved.permissions["documents.view"] !== true) continue;
    matches.push({
      documentId: doc.id,
      documentRef: doc.documentRef,
      titleValue: doc.titleValue,
      folderId: doc.folderId,
      fileName: v.fileName,
    });
  }
  return matches;
}

export interface NeedsDetailsItem {
  id: string;
  documentRef: string;
  titleValue: string | null;
  folderId: string;
  documentType: string;
  missingFields: string[];
}

/**
 * The "needs details" queue (UPL-5): active documents whose type marks fields required but which
 * are missing a value for at least one of them — the files saved incomplete by a never-block
 * upload, to be finished later. Confidential folders the actor isn't named on are excluded at the
 * query layer (a CLAUDE.md hard rule); the route already gates department-level `documents.view`.
 */
export async function listNeedsDetails(
  deps: Deps,
  actor: PermissionActor,
  departmentId: string,
): Promise<NeedsDetailsItem[]> {
  const { prisma } = deps;
  const hiddenFolderIds = await unviewableFolderIdsToExclude(prisma, actor, departmentId);

  const documents = await prisma.document.findMany({
    where: {
      organizationId: actor.organizationId,
      departmentId,
      status: "active",
      folderId: { notIn: hiddenFolderIds.length > 0 ? hiddenFolderIds : ["__none__"] },
      documentType: { fields: { some: { isRequired: true } } },
    },
    include: {
      documentType: { select: { name: true, fields: { where: { isRequired: true }, select: { id: true, label: true } } } },
      fieldValues: { select: { fieldDefId: true, value: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const items: NeedsDetailsItem[] = [];
  for (const doc of documents) {
    const filled = new Set(doc.fieldValues.filter((fv) => fv.value.trim() !== "").map((fv) => fv.fieldDefId));
    const missing = doc.documentType.fields.filter((f) => !filled.has(f.id)).map((f) => f.label);
    if (missing.length === 0) continue;
    items.push({
      id: doc.id,
      documentRef: doc.documentRef,
      titleValue: doc.titleValue,
      folderId: doc.folderId,
      documentType: doc.documentType.name,
      missingFields: missing,
    });
  }
  return items;
}

// ─────────────────────────── trash & recovery (Module 11) ───────────────────────────

/** The retention window before an item in trash is eligible for auto-removal (TRSH-2, default 30d).
 *  R1 has no automated sweep — the countdown is informational; a purge is always a deliberate act. */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Retention-lock guard (TRSH-4). The *source* of a lock — retention rules per document type — is
 * Release 2, so nothing sets a lock in R1 and this always returns false. It exists so the
 * enforcement path (purge/restore refuse a locked item) is in place now and doesn't need retrofitting
 * when R2 supplies the lock: give this a real body and every call site already honours it.
 */
function isRetentionLocked(_document: { id: string }): boolean {
  return false;
}

/** Confirms the actor is a Department Admin of a department (both member-management and rules
 *  capability) — the authority required to permanently purge (TRSH-3). */
async function requireDepartmentAdmin(deps: Deps, actor: PermissionActor, departmentId: string) {
  const membership = await deps.prisma.membership.findFirst({
    where: { organizationId: actor.organizationId, departmentId, userId: actor.userId, status: "active" },
    include: { role: true },
  });
  if (!membership || !hasDepartmentAdminCapability(membership.role.permissions)) {
    throw new DocumentError(403, "forbidden", "Only a Department Admin can permanently delete from trash.");
  }
}

/** Soft-delete: move a document to trash (TRSH-1). Recoverable — never immediate destruction. */
export async function deleteDocument(deps: Deps, actor: PermissionActor, documentId: string) {
  const { prisma } = deps;
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.delete");
  if (document.status !== "active") {
    throw new DocumentError(409, "already_in_trash", "This document is already in the trash.");
  }

  await prisma.document.update({
    where: { id: document.id },
    data: { status: "in_trash", deletedAt: new Date(), deletedByUserId: actor.userId },
  });
  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "delete",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Moved to trash: ${document.documentRef}`,
  });
  return { id: document.id, status: "in_trash" as const };
}

export interface TrashItem {
  id: string;
  documentRef: string;
  titleValue: string | null;
  documentType: string;
  originFolderId: string;
  originFolderName: string;
  fileName: string | null;
  mimeType: string | null;
  deletedAt: Date | null;
  deletedByName: string | null;
  daysUntilAutoRemove: number;
  retentionLocked: boolean;
}

/**
 * The department's trash (TRSH-2): items in trash the actor may see, each with who deleted it, its
 * origin folder, and an auto-remove countdown. Confidential folders the actor isn't named on are
 * excluded at the query layer. Gated at the route by `documents.restore`.
 */
export async function listTrash(deps: Deps, actor: PermissionActor, departmentId: string): Promise<TrashItem[]> {
  const { prisma } = deps;
  const hiddenFolderIds = await unviewableFolderIdsToExclude(prisma, actor, departmentId);

  const documents = await prisma.document.findMany({
    where: {
      organizationId: actor.organizationId,
      departmentId,
      status: "in_trash",
      folderId: { notIn: hiddenFolderIds.length > 0 ? hiddenFolderIds : ["__none__"] },
    },
    include: {
      documentType: { select: { name: true } },
      folder: { select: { id: true, name: true } },
      currentVersion: { select: { fileName: true, mimeType: true } },
    },
    orderBy: { deletedAt: "desc" },
  });

  const deleterIds = [...new Set(documents.map((d) => d.deletedByUserId).filter((id): id is string => Boolean(id)))];
  const deleters = new Map(
    (await prisma.user.findMany({ where: { id: { in: deleterIds } }, select: { id: true, fullName: true } })).map(
      (u) => [u.id, u.fullName],
    ),
  );

  const dayMs = 24 * 60 * 60 * 1000;
  return documents.map((d) => {
    const elapsedDays = d.deletedAt ? Math.floor((Date.now() - d.deletedAt.getTime()) / dayMs) : 0;
    return {
      id: d.id,
      documentRef: d.documentRef,
      titleValue: d.titleValue,
      documentType: d.documentType.name,
      originFolderId: d.folder.id,
      originFolderName: d.folder.name,
      fileName: d.currentVersion?.fileName ?? null,
      mimeType: d.currentVersion?.mimeType ?? null,
      deletedAt: d.deletedAt,
      deletedByName: d.deletedByUserId ? (deleters.get(d.deletedByUserId) ?? null) : null,
      daysUntilAutoRemove: Math.max(0, TRASH_RETENTION_DAYS - elapsedDays),
      retentionLocked: isRetentionLocked(d),
    };
  });
}

/** Restore a trashed document to its origin folder (TRSH-2), ID/metadata/version history intact. */
export async function restoreDocument(deps: Deps, actor: PermissionActor, documentId: string) {
  const { prisma } = deps;
  const document = await loadDocumentForActor(deps, actor, documentId, "documents.restore");
  if (document.status !== "in_trash") {
    throw new DocumentError(409, "not_in_trash", "This document isn't in the trash.");
  }
  if (isRetentionLocked(document)) {
    throw new DocumentError(409, "retention_locked", "This document is under a retention lock and can't be changed.");
  }

  await prisma.document.update({
    where: { id: document.id },
    data: { status: "active", deletedAt: null, deletedByUserId: null },
  });
  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "restore",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Restored from trash: ${document.documentRef}`,
  });
  return shapeDocument(await loadRawDocument(deps, actor.organizationId, document.id));
}

/**
 * Permanently delete a trashed document (TRSH-3) — the only place data truly disappears. Department
 * Admin only, blocked by a retention lock (TRSH-4). Deletes the version files through the storage
 * abstraction and the version / field-value / share / document rows; the append-only audit trail
 * survives because `audit_event.document_id` is `ON DELETE SET NULL`.
 */
export async function purgeDocument(
  deps: { prisma: PrismaClient; env: Env },
  actor: PermissionActor,
  documentId: string,
) {
  const { prisma } = deps;
  const document = await prisma.document.findFirst({
    where: { id: documentId, organizationId: actor.organizationId },
    include: { versions: { select: { storageRef: true, fileSize: true } } },
  });
  if (!document) throw new DocumentError(404, "document_not_found", "Document not found.");

  // Being a Department Admin is authority over the department's *visible* content, not a way past
  // the confidential boundary: a vault is invisible to anyone not on its named list, and destroying
  // what you cannot see is strictly worse than listing it. Resolved for the document's own folder,
  // so a confidential document reports `document_not_found` to a non-member exactly as it does
  // everywhere else — the refusal must not confirm the document exists (Feature Spec §11.2).
  const resolved = await resolveEffectivePermissions(
    prisma,
    actor,
    document.departmentId,
    document.folderId,
  );
  if (resolved.permissions["documents.view"] !== true) {
    throw new DocumentError(404, "document_not_found", "Document not found.");
  }

  if (document.status !== "in_trash") {
    throw new DocumentError(409, "not_in_trash", "Only items in the trash can be permanently deleted.");
  }
  await requireDepartmentAdmin(deps, actor, document.departmentId);
  if (isRetentionLocked(document)) {
    throw new DocumentError(409, "retention_locked", "This document is under a retention lock and can't be purged.");
  }

  // Log while the document row (and its FK) still exists; the SET-NULL cascade nulls the reference
  // as the row is deleted, leaving the event's action/actor/ref intact.
  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "delete",
    documentId: document.id,
    departmentId: document.departmentId,
    targetDescription: `Permanently deleted: ${document.documentRef}`,
  });

  // Delete the stored files first. A restore path reuses a version's storage_ref (never a fresh
  // copy), so distinct refs are the unit to delete; failures are swallowed so a missing object can't
  // strand a purge, but usage is only reverted for what we attempted.
  const driver = await getActiveStorageDriver(deps, actor.organizationId);
  const seenRefs = new Set<string>();
  let freedBytes = 0;
  for (const v of document.versions) {
    if (seenRefs.has(v.storageRef)) continue;
    seenRefs.add(v.storageRef);
    freedBytes += v.fileSize;
    await driver.delete(v.storageRef).catch(() => {});
  }

  await prisma.$transaction(async (tx) => {
    await tx.fieldValue.deleteMany({ where: { documentId: document.id } });
    await tx.share.deleteMany({ where: { documentId: document.id } });
    await tx.document.update({ where: { id: document.id }, data: { currentVersionId: null } });
    await tx.version.deleteMany({ where: { documentId: document.id } });
    await tx.document.delete({ where: { id: document.id } });
  });

  if (freedBytes > 0) {
    await prisma.storageConfig
      .updateMany({ where: { organizationId: actor.organizationId }, data: { usedBytes: { decrement: BigInt(freedBytes) } } })
      .catch(() => {});
  }

  return { id: documentId, purged: true };
}

/** Empty the department's trash (TRSH-3): purge every item except those under a retention lock. */
export async function emptyTrash(
  deps: { prisma: PrismaClient; env: Env },
  actor: PermissionActor,
  departmentId: string,
) {
  const { prisma } = deps;
  await requireDepartmentAdmin(deps, actor, departmentId);

  // Exactly the set `listTrash` showed the caller — confidential folders they aren't named on are
  // excluded at the query layer, so "Empty trash" can never silently destroy documents that were
  // invisible on the screen the button sits on. `purgeDocument` re-checks per item as well.
  const hiddenFolderIds = await unviewableFolderIdsToExclude(prisma, actor, departmentId);

  const trashed = await prisma.document.findMany({
    where: {
      organizationId: actor.organizationId,
      departmentId,
      status: "in_trash",
      folderId: { notIn: hiddenFolderIds.length > 0 ? hiddenFolderIds : ["__none__"] },
    },
    select: { id: true },
  });

  let purged = 0;
  let skipped = 0;
  for (const doc of trashed) {
    try {
      await purgeDocument(deps, actor, doc.id);
      purged++;
    } catch (err) {
      // A retention-locked item is skipped, not fatal (TRSH-4); anything else is re-thrown.
      if (err instanceof DocumentError && err.code === "retention_locked") skipped++;
      else throw err;
    }
  }
  return { purged, skipped };
}
