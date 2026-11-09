import { ApiRequestError, apiRequest } from "./api";

// Retention (PRD v1.2 RET-1..8): the department's auto-delete period, the Upcoming Deletions list,
// and Legal Holds. Every rule is enforced by the server; these only carry requests and shape replies.

export interface AutoDeleteSetting {
  departmentId: string;
  autoDeleteYears: number | null;
  timeZone: string;
  nextRunAt: string;
  nextRunDate: string;
  schedule: { time: string; timeZone: string };
}

export interface AutoDeletePreview {
  currentYears: number | null;
  autoDeleteYears: number | null;
  requiresConfirmation: boolean;
  affectedCount: number;
  nextRunAt: string;
  nextRunDate: string;
  message: string;
}

export interface UpcomingDeletion {
  id: string;
  documentRef: string;
  titleValue: string | null;
  documentType: string;
  folderId: string;
  folderName: string;
  uploadedAt: string;
  uploadDate: string;
  dueDate: string;
  scheduledDate: string;
  legalHold: boolean;
  canManageHold: boolean;
}

export interface UpcomingDeletions {
  autoDeleteYears: number | null;
  windowDays: number;
  today: string;
  nextRunAt: string;
  nextRunDate: string;
  items: UpcomingDeletion[];
}

export interface LegalHoldView {
  id: string;
  scope: "document" | "folder";
  documentId: string | null;
  documentRef: string | null;
  titleValue: string | null;
  folderId: string | null;
  folderName: string | null;
  reason: string;
  placedByName: string;
  placedAt: string;
}

/** A hold that covers a document, as the viewer shows it — its own, or inherited from a folder. */
export interface CoveringHold {
  id: string;
  scope: "document" | "folder";
  folderId: string | null;
  folderName: string | null;
  reason: string;
  placedAt: string;
  placedByName: string;
}

export const fetchAutoDeleteSetting = (departmentId: string) =>
  apiRequest<AutoDeleteSetting>(`/departments/${departmentId}/retention`);

export const previewAutoDelete = (departmentId: string, autoDeleteYears: number | null) =>
  apiRequest<AutoDeletePreview>(`/departments/${departmentId}/retention/preview`, {
    method: "POST",
    body: JSON.stringify({ autoDeleteYears }),
  });

/** Saves the period. Setting or shortening it is refused (409) until `confirm` is true. */
export const saveAutoDeletePeriod = (departmentId: string, autoDeleteYears: number | null, confirm = false) =>
  apiRequest<AutoDeleteSetting & { affectedCount: number }>(`/departments/${departmentId}/retention`, {
    method: "PUT",
    body: JSON.stringify({ autoDeleteYears, confirm }),
  });

/** The preview the server attaches to a `confirmation_required` refusal. */
export function previewFromError(err: unknown): AutoDeletePreview | null {
  if (err instanceof ApiRequestError && err.code === "confirmation_required") {
    const details = err.details as unknown as { preview?: AutoDeletePreview } | undefined;
    return details?.preview ?? null;
  }
  return null;
}

export const fetchUpcomingDeletions = (departmentId: string) =>
  apiRequest<UpcomingDeletions>(`/departments/${departmentId}/retention/upcoming`);

export const fetchLegalHolds = (departmentId: string) =>
  apiRequest<{ holds: LegalHoldView[] }>(`/departments/${departmentId}/legal-holds`).then((r) => r.holds);

export const placeDocumentHold = (documentId: string, reason: string) =>
  apiRequest<{ hold: { id: string; documentId: string; reason: string; placedAt: string } }>(
    `/documents/${documentId}/legal-hold`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );

export const placeFolderHold = (departmentId: string, folderId: string, reason: string) =>
  apiRequest(`/departments/${departmentId}/folders/${folderId}/legal-hold`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });

export const removeLegalHold = (holdId: string) => apiRequest(`/legal-holds/${holdId}`, { method: "DELETE" });

/** "2026-11-15" → "15 Nov 2026", read as a calendar date (never shifted by the browser's zone). */
export function formatCalendarDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}
