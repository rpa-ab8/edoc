import { ApiRequestError, apiRequest, refreshAccessToken } from "./api";
import { useAuthStore } from "../store/authStore";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export interface DocumentSummary {
  id: string;
  documentRef: string;
  titleValue: string | null;
  documentType: string;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  updatedAt: string;
}

export interface DuplicateMatch {
  documentId: string;
  documentRef: string;
  titleValue: string | null;
  folderId: string;
  fileName: string;
}

export interface DocumentFieldValue {
  fieldDefId: string;
  label: string;
  fieldType: string;
  value: string;
}

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  ocrStatus: "pending" | "done" | "failed";
  changeNote: string | null;
  isCurrent: boolean;
  uploadedBy: { id: string; fullName: string; email: string } | null;
  createdAt: string;
}

export interface DocumentActivity {
  id: string;
  action: string;
  actorName: string;
  description: string | null;
  occurredAt: string;
}

export interface DocumentDetail {
  id: string;
  documentRef: string;
  titleValue: string | null;
  departmentId: string;
  folderId: string;
  status: string;
  documentType: { id: string; name: string; idCode: string };
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  fieldValues: DocumentFieldValue[];
  versions: DocumentVersion[];
  // Present on the viewer's detail fetch (GET /documents/:id); absent on the shapes returned by
  // the edit/restore/version actions.
  permissions?: Record<string, boolean>;
  activity?: DocumentActivity[];
}

export interface NeedsDetailsItem {
  id: string;
  documentRef: string;
  titleValue: string | null;
  folderId: string;
  documentType: string;
  missingFields: string[];
}

export type SubmittedFieldValue = { fieldDefId: string; value: string };

export const fetchFolderDocuments = (departmentId: string, folderId: string) =>
  apiRequest<{ documents: DocumentSummary[] }>(
    `/documents?departmentId=${departmentId}&folderId=${folderId}`,
  ).then((r) => r.documents);

export const fetchDocument = (documentId: string) =>
  apiRequest<{ document: DocumentDetail }>(`/documents/${documentId}`).then((r) => r.document);

export const fetchNeedsDetails = (departmentId: string) =>
  apiRequest<{ documents: NeedsDetailsItem[] }>(
    `/departments/${departmentId}/documents/needs-details`,
  ).then((r) => r.documents);

export const editDocumentMetadata = (documentId: string, fieldValues: SubmittedFieldValue[]) =>
  apiRequest<{ document: DocumentDetail }>(`/documents/${documentId}/metadata`, {
    method: "PATCH",
    body: JSON.stringify({ fieldValues }),
  }).then((r) => r.document);

export const restoreDocumentVersion = (documentId: string, versionId: string) =>
  apiRequest<{ document: DocumentDetail }>(`/documents/${documentId}/versions/${versionId}/restore`, {
    method: "POST",
  }).then((r) => r.document);

// ── Trash & recovery (Module 11) ──────────────────────────────────────────────

export interface TrashItem {
  id: string;
  documentRef: string;
  titleValue: string | null;
  documentType: string;
  originFolderId: string;
  originFolderName: string;
  fileName: string | null;
  mimeType: string | null;
  deletedAt: string | null;
  deletedByName: string | null;
  daysUntilAutoRemove: number;
  retentionLocked: boolean;
}

/** Move a document to trash (soft delete). */
export const deleteDocument = (documentId: string) =>
  apiRequest<{ id: string; status: string }>(`/documents/${documentId}`, { method: "DELETE" });

/** Restore a trashed document to its origin folder. */
export const restoreDocument = (documentId: string) =>
  apiRequest<{ document: DocumentDetail }>(`/documents/${documentId}/restore`, { method: "POST" }).then(
    (r) => r.document,
  );

/** Permanently delete a trashed document (Department Admin only). */
export const purgeDocument = (documentId: string) =>
  apiRequest<{ id: string; purged: boolean }>(`/documents/${documentId}/purge`, { method: "POST" });

export const fetchTrash = (departmentId: string) =>
  apiRequest<{ items: TrashItem[] }>(`/departments/${departmentId}/trash`).then((r) => r.items);

export const emptyTrash = (departmentId: string) =>
  apiRequest<{ purged: number; skipped: number }>(`/departments/${departmentId}/trash/empty`, {
    method: "POST",
  });

export const fetchDocumentActivity = (documentId: string) =>
  apiRequest<{ activity: DocumentActivity[] }>(`/documents/${documentId}/activity`).then((r) => r.activity);

// ── Authenticated file access ────────────────────────────────────────────────
// The file route needs the Bearer token, which an <img>/<iframe> src can't carry, so the bytes are
// fetched here and turned into an object URL (preview) or triggered as a download.

async function fetchFileBlob(documentId: string, versionId?: string, download?: boolean): Promise<Blob> {
  const params = new URLSearchParams();
  if (versionId) params.set("versionId", versionId);
  if (download) params.set("download", "1");
  const qs = params.toString();
  const url = `${API_URL}/documents/${documentId}/file${qs ? `?${qs}` : ""}`;

  const send = (token: string | null) =>
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, credentials: "include" });

  let res = await send(useAuthStore.getState().accessToken);
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      useAuthStore.getState().setAccessToken(refreshed);
      res = await send(refreshed);
    }
  }
  if (!res.ok) {
    const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : {};
    throw new ApiRequestError(res.status, (body as { error?: string }).error ?? "file_error", "Couldn't load the file.");
  }
  return res.blob();
}

/** An object URL for inline preview. The caller must revoke it when done. */
export const fetchPreviewObjectUrl = async (documentId: string, versionId?: string) =>
  URL.createObjectURL(await fetchFileBlob(documentId, versionId));

export async function downloadDocumentFile(documentId: string, versionId: string | undefined, fileName: string) {
  const blob = await fetchFileBlob(documentId, versionId, true);
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = fileName;
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isPreviewable(mimeType: string | null | undefined): "pdf" | "image" | null {
  const m = (mimeType ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  return null;
}

// ── Multipart uploads ────────────────────────────────────────────────────────
// FormData must be sent without an explicit Content-Type so the browser sets the multipart
// boundary itself — so these bypass `apiRequest` (which forces application/json) and carry their
// own auth + refresh-once-on-401 handling.

async function multipartPost<T>(path: string, form: FormData): Promise<T> {
  const send = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: "include",
    });

  let res = await send(useAuthStore.getState().accessToken);
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      useAuthStore.getState().setAccessToken(refreshed);
      res = await send(refreshed);
    }
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiRequestError(
      res.status,
      err.error ?? "unknown_error",
      err.message ?? "Upload failed",
      // `details` on a duplicate error carries the matched documents, not field errors — carried
      // through the same slot and read back by `duplicatesFromError`.
      err.details as Record<string, string[] | undefined> | undefined,
    );
  }
  return body as T;
}

export type DuplicateResolution = "new_version" | "keep_both" | "skip";

export interface UploadResult {
  action: "created" | "new_version" | "skipped";
  document?: DocumentDetail;
}

export function uploadDocument(
  departmentId: string,
  folderId: string,
  input: {
    documentTypeId: string;
    fieldValues: SubmittedFieldValue[];
    file: File;
    onDuplicate?: DuplicateResolution;
    duplicateOfDocumentId?: string;
    changeNote?: string;
  },
): Promise<UploadResult> {
  const form = new FormData();
  form.append("documentTypeId", input.documentTypeId);
  form.append("fieldValues", JSON.stringify(input.fieldValues));
  if (input.onDuplicate) form.append("onDuplicate", input.onDuplicate);
  if (input.duplicateOfDocumentId) form.append("duplicateOfDocumentId", input.duplicateOfDocumentId);
  if (input.changeNote) form.append("changeNote", input.changeNote);
  // The file is appended last so the server has every field before it streams the bytes.
  form.append("file", input.file, input.file.name);
  return multipartPost<UploadResult>(
    `/departments/${departmentId}/folders/${folderId}/documents/upload`,
    form,
  );
}

export function uploadNewVersion(
  documentId: string,
  file: File,
  changeNote?: string,
): Promise<{ document: DocumentDetail }> {
  const form = new FormData();
  if (changeNote) form.append("changeNote", changeNote);
  form.append("file", file, file.name);
  return multipartPost<{ document: DocumentDetail }>(`/documents/${documentId}/versions/upload`, form);
}

/** The duplicate matches carried on a 409 `duplicate_detected` error. */
export function duplicatesFromError(err: unknown): DuplicateMatch[] {
  if (err instanceof ApiRequestError && err.code === "duplicate_detected") {
    const details = err.details as unknown as { duplicates?: DuplicateMatch[] } | undefined;
    return details?.duplicates ?? [];
  }
  return [];
}

export const ACCEPTED_UPLOAD_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "docx", "xlsx"];
export const ACCEPTED_UPLOAD_ACCEPT = ".pdf,.jpg,.jpeg,.png,.docx,.xlsx";

export function humanFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
