import { ApiRequestError, apiRequest, refreshAccessToken } from "./api";
import { useAuthStore } from "../store/authStore";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export type AuditAction =
  | "view" | "upload" | "download" | "edit" | "delete" | "restore" | "share"
  | "link_access" | "role_change" | "member_change" | "config_change"
  | "permission_change" | "workflow_transition";

export interface AuditEvent {
  id: string;
  action: AuditAction;
  actorName: string;
  documentRef: string | null;
  targetDescription: string | null;
  isConfidential: boolean;
  occurredAt: string;
}

export interface AuditFilters {
  actorUserId?: string;
  action?: AuditAction;
  documentQuery?: string;
  from?: string; // ISO
  to?: string; // ISO
}

export const ACTION_LABELS: Record<AuditAction, string> = {
  view: "View",
  upload: "Upload",
  download: "Download",
  edit: "Edit",
  delete: "Delete",
  restore: "Restore",
  share: "Share",
  link_access: "Link access",
  role_change: "Role change",
  member_change: "Member change",
  config_change: "Config change",
  permission_change: "Permission change",
  workflow_transition: "Workflow",
};

/** Colour weighting so destructive and privilege events stand out (AUD-2). */
export function actionTone(action: AuditAction): "danger" | "warning" | "info" | "muted" {
  if (action === "delete") return "danger";
  if (action === "role_change" || action === "member_change" || action === "permission_change") return "warning";
  if (action === "share" || action === "link_access") return "info";
  return "muted";
}

function toQuery(filters: AuditFilters): string {
  const p = new URLSearchParams();
  if (filters.actorUserId) p.set("actorUserId", filters.actorUserId);
  if (filters.action) p.set("action", filters.action);
  if (filters.documentQuery) p.set("documentQuery", filters.documentQuery);
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const fetchAudit = (departmentId: string, filters: AuditFilters) =>
  apiRequest<{ events: AuditEvent[]; canExport: boolean; includesConfidential: boolean }>(
    `/departments/${departmentId}/audit${toQuery(filters)}`,
  );

/** Downloads the filtered audit log as CSV (authed fetch, since a link can't carry the token). */
export async function exportAuditCsv(departmentId: string, filters: AuditFilters) {
  const url = `${API_URL}/departments/${departmentId}/audit/export${toQuery(filters)}`;
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
    throw new ApiRequestError(res.status, (body as { error?: string }).error ?? "export_error", "Couldn't export the audit log.");
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = href;
  a.download = `audit-${departmentId}-${new Date().toISOString().slice(0, 10)}.csv`;
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
