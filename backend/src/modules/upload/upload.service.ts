import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env.js";
import type { PermissionActor } from "../../lib/effective-permissions.js";
import {
  verifyUploadFormat,
  extractPlainText,
  ACCEPTED_EXTENSIONS,
  type AcceptedFormat,
} from "../../lib/upload-formats.js";
import { enqueueOcr } from "../../lib/queue.js";
import * as storageService from "../storage/storage.service.js";
import * as documentService from "../document/document.service.js";
import type { DuplicateMatch, SubmittedFieldValue } from "../document/document.service.js";

export class UploadError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface Deps {
  prisma: PrismaClient;
  env: Env;
}

export interface IncomingFile {
  fileName: string;
  declaredMime?: string;
  data: Buffer;
}

export type DuplicateResolution = "new_version" | "keep_both" | "skip";

export interface UploadInput {
  departmentId: string;
  folderId: string;
  documentTypeId: string;
  fieldValues: SubmittedFieldValue[];
  file: IncomingFile;
  changeNote?: string | null;
  /** How to resolve a content duplicate; omitted means "stop and ask" if one is found. */
  onDuplicate?: DuplicateResolution;
  /** The document to add-a-version to, when `onDuplicate === "new_version"`. */
  duplicateOfDocumentId?: string;
}

function validateFile(env: Env, file: IncomingFile) {
  if (file.data.length === 0) {
    throw new UploadError(400, "empty_file", "The file is empty.");
  }
  if (file.data.length > env.MAX_UPLOAD_BYTES) {
    const mb = Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024));
    throw new UploadError(413, "file_too_large", `File is larger than the ${mb}MB limit.`);
  }
  // The file's bytes, not its name or declared type, decide what it is (SECURITY_AUDIT.md M-5).
  const verdict = verifyUploadFormat(file.declaredMime, file.fileName, file.data);
  if (!verdict.ok) {
    const label = (f?: AcceptedFormat) => (f?.extensions[0] ?? "file").toUpperCase();
    const message =
      verdict.code === "unsupported_format"
        ? `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}.`
        : verdict.code === "unrecognised_content"
          ? `This file isn't a valid ${label(verdict.claimed)} — its contents don't match. It may be damaged or renamed.`
          : `This file is named as a ${label(verdict.claimed)} but its contents are a ${label(verdict.detected)}. Rename it to .${verdict.detected!.extensions[0]} and upload again.`;
    throw new UploadError(400, verdict.code, message);
  }
  return verdict.format;
}

/** Only images and PDFs go to the OCR worker; Office files have no text pass, and text files carry
 *  their own text, stored at upload. */
function needsOcr(format: AcceptedFormat): boolean {
  return format.ocr === "image" || format.ocr === "pdf";
}

/**
 * The version's text-extraction fields at upload: a Markdown / plain-text file *is* its searchable
 * text, so it is stored now (status `done`) and the document is fully searchable without the OCR
 * worker; formats the worker handles start `pending`; Office files are `done` with no text.
 */
function ocrFields(format: AcceptedFormat, data: Buffer): { ocrStatus: "pending" | "done"; ocrText?: string | null } {
  if (format.ocr === "text") return { ocrStatus: "done", ocrText: extractPlainText(data) || null };
  return { ocrStatus: needsOcr(format) ? "pending" : "done" };
}

/**
 * Stores the bytes through the org's storage driver, records the usage, and returns the opaque
 * storage_ref. Never a raw path — the driver owns the key layout (CLAUDE.md hard rule).
 */
async function storeBytes(deps: Deps, actor: PermissionActor, file: IncomingFile, mimeType: string) {
  const driver = await storageService.getActiveStorageDriver(deps, actor.organizationId);
  const key = `${actor.organizationId}/${randomUUID()}`;
  const storageRef = await driver.put(key, file.data, mimeType);
  await storageService.recordStorageUsage(deps, actor.organizationId, file.data.length);
  return { driver, storageRef };
}

/**
 * The single upload path (UPL-1..7). Validates format and size, hashes the bytes for duplicate
 * detection, stores the file, and creates a document (or a new version of an existing one). Uses
 * the "never block" create mode so a file is never rejected for missing metadata — it lands and
 * surfaces in the needs-details queue instead.
 *
 * Bulk upload is simply this called once per file by the client (each independent, so one file's
 * missing detail never holds up the batch); the shared-fields bar is applied client-side.
 */
export async function uploadDocument(deps: Deps, actor: PermissionActor, input: UploadInput) {
  // The target folder must belong to the department the route's `documents.upload` gate was resolved
  // for (SECURITY_AUDIT.md H-1). Checked before any bytes are stored, so a refused upload never
  // leaves an orphaned object in storage. Reported as not-found, never as forbidden.
  const folder = await deps.prisma.folder.findFirst({
    where: { id: input.folderId, organizationId: actor.organizationId, departmentId: input.departmentId },
    select: { id: true },
  });
  if (!folder) throw new UploadError(404, "folder_not_found", "Folder not found.");

  const format = validateFile(deps.env, input.file);
  const checksum = createHash("sha256").update(input.file.data).digest("hex");
  const canonicalMime = format.mimeType;

  // ── duplicate handling (UPL-4) ──
  if (!input.onDuplicate) {
    const duplicates = await documentService.findDuplicatesInDepartment(
      deps,
      actor,
      input.departmentId,
      checksum,
    );
    if (duplicates.length > 0) {
      throw new UploadError(
        409,
        "duplicate_detected",
        "This file already exists in this department.",
        { duplicates } satisfies { duplicates: DuplicateMatch[] },
      );
    }
  }

  if (input.onDuplicate === "skip") {
    return { action: "skipped" as const };
  }

  // Adding the file as a new version of an existing document.
  if (input.onDuplicate === "new_version") {
    if (!input.duplicateOfDocumentId) {
      throw new UploadError(400, "duplicate_target_required", "Which document should this be a new version of?");
    }
    const { driver, storageRef } = await storeBytes(deps, actor, input.file, canonicalMime);
    try {
      const document = await documentService.addVersion(deps, actor, input.duplicateOfDocumentId, {
        file: {
          storageRef,
          fileName: input.file.fileName,
          fileSize: input.file.data.length,
          mimeType: canonicalMime,
          checksum,
          ...ocrFields(format, input.file.data),
        },
        changeNote: input.changeNote ?? null,
      });
      if (needsOcr(format) && document.currentVersionId) {
        await enqueueOcr(deps.env, document.currentVersionId);
      }
      return { action: "new_version" as const, document };
    } catch (err) {
      // The document/version write failed after the object was stored — remove the orphan so
      // storage doesn't accumulate unreferenced files.
      await driver.delete(storageRef).catch(() => {});
      await storageService.recordStorageUsage(deps, actor.organizationId, -input.file.data.length).catch(() => {});
      throw err;
    }
  }

  // ── new document (keep_both, or no duplicate) ──
  const { driver, storageRef } = await storeBytes(deps, actor, input.file, canonicalMime);
  try {
    const document = await documentService.createDocument(deps, actor, {
      folderId: input.folderId,
      documentTypeId: input.documentTypeId,
      fieldValues: input.fieldValues,
      file: {
        storageRef,
        fileName: input.file.fileName,
        fileSize: input.file.data.length,
        mimeType: canonicalMime,
        checksum,
        ...ocrFields(format, input.file.data),
      },
      allowIncomplete: true,
    });
    if (needsOcr(format) && document.currentVersionId) {
      await enqueueOcr(deps.env, document.currentVersionId);
    }
    return { action: "created" as const, document };
  } catch (err) {
    await driver.delete(storageRef).catch(() => {});
    await storageService.recordStorageUsage(deps, actor.organizationId, -input.file.data.length).catch(() => {});
    throw err;
  }
}

/** Upload a new version of an existing document from the viewer (DOC-4 / UPL). */
export async function uploadNewVersion(
  deps: Deps,
  actor: PermissionActor,
  documentId: string,
  file: IncomingFile,
  changeNote?: string | null,
) {
  const format = validateFile(deps.env, file);
  const checksum = createHash("sha256").update(file.data).digest("hex");
  const canonicalMime = format.mimeType;

  const { driver, storageRef } = await storeBytes(deps, actor, file, canonicalMime);
  try {
    const document = await documentService.addVersion(deps, actor, documentId, {
      file: {
        storageRef,
        fileName: file.fileName,
        fileSize: file.data.length,
        mimeType: canonicalMime,
        checksum,
        ...ocrFields(format, file.data),
      },
      changeNote: changeNote ?? null,
    });
    if (needsOcr(format) && document.currentVersionId) {
      await enqueueOcr(deps.env, document.currentVersionId);
    }
    return { document };
  } catch (err) {
    await driver.delete(storageRef).catch(() => {});
    await storageService.recordStorageUsage(deps, actor.organizationId, -file.data.length).catch(() => {});
    throw err;
  }
}
