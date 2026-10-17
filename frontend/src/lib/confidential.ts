import { apiRequest } from "./api";

export interface ConfidentialMember {
  userId: string;
  fullName: string;
  email: string;
  isOwner: boolean;
}

export interface ConfidentialMembers {
  folderId: string;
  folderName: string;
  members: ConfidentialMember[];
}

export interface OrphanedVault {
  folderId: string;
  folderName: string;
}

export interface Recovery {
  id: string;
  folderId: string;
  folderName: string;
  newMemberName: string;
  status: string;
  superAdminApproved: boolean;
  deptAdminApproved: boolean;
  createdAt: string;
}

// ── named-list management ──
export const fetchConfidentialMembers = (folderId: string) =>
  apiRequest<ConfidentialMembers>(`/folders/${folderId}/confidential/members`);

export const addConfidentialMember = (folderId: string, userId: string) =>
  apiRequest<ConfidentialMembers>(`/folders/${folderId}/confidential/members`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });

export const removeConfidentialMember = (folderId: string, userId: string) =>
  apiRequest<ConfidentialMembers>(`/folders/${folderId}/confidential/members/${userId}`, {
    method: "DELETE",
  });

// ── dual-control recovery ──
export const fetchOrphanedVaults = (departmentId: string) =>
  apiRequest<{ folders: OrphanedVault[] }>(`/departments/${departmentId}/confidential/orphaned`).then(
    (r) => r.folders,
  );

export const fetchRecoveries = (departmentId: string) =>
  apiRequest<{ recoveries: Recovery[] }>(`/departments/${departmentId}/confidential/recoveries`).then(
    (r) => r.recoveries,
  );

export const initiateRecovery = (departmentId: string, folderId: string, newMemberUserId: string) =>
  apiRequest<{ recovery: Recovery }>(
    `/departments/${departmentId}/confidential/folders/${folderId}/recovery`,
    { method: "POST", body: JSON.stringify({ newMemberUserId }) },
  ).then((r) => r.recovery);

export const approveRecovery = (departmentId: string, recoveryId: string) =>
  apiRequest<{ recovery: Recovery }>(
    `/departments/${departmentId}/confidential/recoveries/${recoveryId}/approve`,
    { method: "POST" },
  ).then((r) => r.recovery);
