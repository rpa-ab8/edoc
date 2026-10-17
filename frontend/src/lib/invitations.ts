import { apiRequest } from "./api";

export interface PendingInvitation {
  id: string;
  email: string;
  departmentId: string;
  departmentName: string;
  roleId: string;
  roleName: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  isExpired: boolean;
}

export interface InvitationPreview {
  email: string;
  organizationName: string;
  departmentName: string;
  roleName: string;
  expiresAt: string;
  hasAccount: boolean;
}

export const fetchDepartmentInvitations = (departmentId: string) =>
  apiRequest<{ invitations: PendingInvitation[] }>(`/departments/${departmentId}/invitations`).then(
    (r) => r.invitations,
  );

export const fetchOrganizationInvitations = () =>
  apiRequest<{ invitations: PendingInvitation[] }>("/organizations/current/invitations").then(
    (r) => r.invitations,
  );

export const createInvitation = (departmentId: string, body: { email: string; roleId: string }) =>
  apiRequest(`/departments/${departmentId}/invitations`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const resendInvitation = (departmentId: string, invitationId: string) =>
  apiRequest(`/departments/${departmentId}/invitations/${invitationId}/resend`, { method: "POST" });

export const revokeInvitation = (departmentId: string, invitationId: string) =>
  apiRequest(`/departments/${departmentId}/invitations/${invitationId}`, { method: "DELETE" });

/** Public — the recipient has a link, not a session. */
export const fetchInvitationPreview = (token: string) =>
  apiRequest<{ invitation: InvitationPreview }>(`/invitations/${token}`).then((r) => r.invitation);

export const acceptInvitation = (token: string, body: { fullName?: string; password?: string }) =>
  apiRequest<{
    organizationId: string;
    departmentId: string;
    createdAccount: boolean;
    accessToken?: string;
  }>(`/invitations/${token}/accept`, { method: "POST", body: JSON.stringify(body) });
