import { apiRequest } from "./api";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export type SharePermission = "view" | "download";
export type ShareTargetType = "user" | "department" | "external_link";
export type ShareStatus = "active" | "pending" | "revoked" | "expired";

export interface ShareView {
  id: string;
  documentId: string;
  documentRef: string;
  documentTitle: string | null;
  sourceDepartmentId: string;
  sourceDepartmentName: string;
  targetType: ShareTargetType;
  targetLabel: string;
  permission: SharePermission;
  status: ShareStatus;
  expiresAt: string | null;
  openedCount: number;
  sharedByName: string;
  createdAt: string;
}

export interface CreateShareInput {
  targetType: ShareTargetType;
  targetUserId?: string;
  targetDepartmentId?: string;
  permission: SharePermission;
  expiresInDays?: number | null;
}

export interface OrgUser {
  id: string;
  fullName: string;
  email: string;
}

/** Everyone in the organization (any department) — backs the share recipient picker (bug 1). */
export const fetchOrgUsers = () =>
  apiRequest<{ users: OrgUser[] }>(`/organizations/current/users`).then((r) => r.users);

export const fetchDocumentShares = (documentId: string) =>
  apiRequest<{ shares: ShareView[] }>(`/documents/${documentId}/shares`).then((r) => r.shares);

export const createShare = (documentId: string, input: CreateShareInput) =>
  apiRequest<{ share: ShareView; linkUrl?: string }>(`/documents/${documentId}/shares`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateShare = (
  shareId: string,
  input: { permission?: SharePermission; expiresInDays?: number | null },
) =>
  apiRequest<{ share: ShareView }>(`/shares/${shareId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((r) => r.share);

export const revokeShare = (shareId: string) =>
  apiRequest<{ id: string; status: ShareStatus }>(`/shares/${shareId}`, { method: "DELETE" });

/** Recipient removes a share from their own "Shared with me" (doesn't revoke it). */
export const dismissShare = (shareId: string) =>
  apiRequest<{ id: string; dismissed: boolean }>(`/shares/${shareId}/dismiss`, { method: "POST" });

export const fetchSharedWithMe = () =>
  apiRequest<{ shares: ShareView[] }>(`/shares/with-me`).then((r) => r.shares);

export const fetchSharedByMe = () =>
  apiRequest<{ shares: ShareView[] }>(`/shares/by-me`).then((r) => r.shares);

// ── Public external-link access (no account, no session) ──────────────────────

export interface ExternalLinkDocument {
  documentRef: string;
  title: string | null;
  permission: SharePermission;
}

export class ExternalLinkError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function openExternalLink(token: string): Promise<ExternalLinkDocument> {
  const res = await fetch(`${API_URL}/links/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ExternalLinkError(body.error ?? "link_unavailable");
  }
  return ((await res.json()) as { document: ExternalLinkDocument }).document;
}

async function externalLinkBlob(token: string, download: boolean): Promise<Blob> {
  const url = `${API_URL}/links/${encodeURIComponent(token)}/file${download ? "?download=1" : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ExternalLinkError(body.error ?? "file_error");
  }
  return res.blob();
}

export async function fetchExternalLinkPreview(token: string): Promise<{ url: string; mimeType: string }> {
  const blob = await externalLinkBlob(token, false);
  return { url: URL.createObjectURL(blob), mimeType: blob.type };
}

export async function downloadExternalLinkFile(token: string, fileName: string) {
  const blob = await externalLinkBlob(token, true);
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = fileName;
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Presentation helpers ──────────────────────────────────────────────────────

export function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return "No expiry";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
  return `Expires in ${hours}h`;
}
