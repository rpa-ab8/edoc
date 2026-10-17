import { apiRequest } from "./api";
import type { PermissionMap } from "./departments";

export interface FolderNode {
  id: string;
  name: string;
  parentFolderId: string | null;
  depth: number;
  isConfidential: boolean;
  subfolderCount: number;
  documentCount: number;
}

export interface MyPermissions {
  permissions: PermissionMap;
  source: "super_admin" | "role" | "role_restricted_by_folder" | "confidential_member" | "none";
  isConfidential: boolean;
  /** The department's effective subfolder depth limit — a folder at this depth can't hold subfolders. */
  subfolderDepthLimit: number;
  /** The caller's role name in this department, or null (e.g. a Super Admin with no membership). */
  roleName: string | null;
}

export const fetchFolders = (departmentId: string) =>
  apiRequest<{ folders: FolderNode[] }>(`/departments/${departmentId}/folders`).then((r) => r.folders);

export const fetchMyPermissions = (departmentId: string, folderId?: string) =>
  apiRequest<MyPermissions>(
    `/departments/${departmentId}/my-permissions${folderId ? `?folderId=${folderId}` : ""}`,
  );

export const createFolder = (
  departmentId: string,
  body: {
    name: string;
    parentFolderId?: string | null;
    isConfidential?: boolean;
    memberUserIds?: string[];
  },
) =>
  apiRequest<{ folder: FolderNode }>(`/departments/${departmentId}/folders`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const renameFolder = (departmentId: string, folderId: string, name: string) =>
  apiRequest(`/departments/${departmentId}/folders/${folderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const moveFolder = (departmentId: string, folderId: string, parentFolderId: string | null) =>
  apiRequest(`/departments/${departmentId}/folders/${folderId}/move`, {
    method: "POST",
    body: JSON.stringify({ parentFolderId }),
  });

export const deleteFolder = (departmentId: string, folderId: string) =>
  apiRequest(`/departments/${departmentId}/folders/${folderId}`, { method: "DELETE" });

// ── folder permission overrides (break inheritance, restrict a role) ──
export interface FolderRolePermission {
  roleId: string;
  roleName: string;
  basePermissions: Record<string, boolean>;
  hasOverride: boolean;
  restrictedKeys: string[];
}
export interface FolderPermissions {
  folderId: string;
  folderName: string;
  roles: FolderRolePermission[];
}

export const fetchFolderPermissions = (departmentId: string, folderId: string) =>
  apiRequest<FolderPermissions>(`/departments/${departmentId}/folders/${folderId}/permissions`);

/** Restrict a role on a folder to everything except `restrict`. An empty array clears the override. */
export const setFolderPermission = (
  departmentId: string,
  folderId: string,
  roleId: string,
  restrict: string[],
) =>
  apiRequest<FolderPermissions>(`/departments/${departmentId}/folders/${folderId}/permissions/${roleId}`, {
    method: "PUT",
    body: JSON.stringify({ restrict }),
  });

/** Root → this folder, for the breadcrumb. Built client-side from the tree we already hold. */
export function pathTo(folders: FolderNode[], folderId: string | null): FolderNode[] {
  const path: FolderNode[] = [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  let current = folderId ? byId.get(folderId) : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return path;
}
