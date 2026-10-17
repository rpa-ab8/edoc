import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { AppShell } from "../components/AppShell";
import { StatusPill } from "../components/AuthCard";
import { fetchOrganizationInvitations } from "../lib/invitations";

interface MemberDepartment {
  departmentId: string;
  departmentName: string;
  roleName: string;
  status: string;
}

interface Member {
  userId: string;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  accountStatus: string;
  departments: MemberDepartment[];
}

export function UserDirectoryPage() {
  const organizations = useAuthStore((s) => s.organizations);
  const currentOrganizationId = useAuthStore((s) => s.currentOrganizationId);
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);

  const { data, refetch } = useQuery({
    queryKey: ["org-members"],
    queryFn: () => apiRequest<{ members: Member[] }>("/organizations/current/members"),
    enabled: currentOrg?.isSuperAdmin ?? false,
  });

  const { data: invitations } = useQuery({
    queryKey: ["org-invitations"],
    queryFn: fetchOrganizationInvitations,
    enabled: currentOrg?.isSuperAdmin ?? false,
  });

  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!currentOrg?.isSuperAdmin) {
    return (
      <AppShell>
        <p className="text-[14.5px] text-muted">Only the Super Admin can view the user directory.</p>
      </AppShell>
    );
  }

  async function toggleEnabled(member: Member, enable: boolean) {
    setBusyUserId(member.userId);
    setError(null);
    setStatus(null);
    try {
      await apiRequest(`/organizations/current/members/${member.userId}/${enable ? "enable" : "disable"}`, {
        method: "PATCH",
      });
      setStatus(`${member.fullName} ${enable ? "enabled" : "disabled"}.`);
      await refetch();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setBusyUserId(null);
    }
  }

  async function resetPassword(member: Member) {
    setBusyUserId(member.userId);
    setError(null);
    setStatus(null);
    try {
      await apiRequest(`/organizations/current/members/${member.userId}/reset-password`, {
        method: "POST",
      });
      setStatus(`Password reset email sent to ${member.email}.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setBusyUserId(null);
    }
  }

  const members = data?.members ?? [];

  return (
    <AppShell>
      <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">User directory</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">Everyone with access to this organization.</p>

      {status && <p className="mt-4 text-[13px] text-success">{status}</p>}
      {error && <p className="mt-4 text-[13px] text-danger">{error}</p>}

      <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Name</th>
              <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                Departments
              </th>
              <th className="px-6 py-3 text-right text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/60">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-medium text-ink">{m.fullName}</span>
                    {m.isSuperAdmin && <StatusPill tone="primary">Super Admin</StatusPill>}
                    {!m.isSuperAdmin && m.departments.length === 0 && (
                      <StatusPill tone="warning">No departments</StatusPill>
                    )}
                  </div>
                  <p className="mt-0.5 text-[13px] text-subtle">{m.email}</p>
                </td>
                <td className="px-6 py-4 text-[15px] text-muted">
                  {m.departments.length > 0
                    ? m.departments.map((d) => `${d.departmentName} · ${d.roleName}`).join(", ")
                    : "—"}
                </td>
                <td className="px-6 py-4">
                  {!m.isSuperAdmin && (
                    <div className="flex justify-end gap-4">
                      <button
                        onClick={() => resetPassword(m)}
                        disabled={busyUserId === m.userId}
                        className="text-[13px] font-medium text-primary hover:text-primary-dark hover:underline disabled:opacity-50"
                      >
                        Reset password
                      </button>
                      <button
                        onClick={() => toggleEnabled(m, m.departments.every((d) => d.status !== "active"))}
                        disabled={busyUserId === m.userId}
                        className="text-[13px] font-medium text-danger hover:underline disabled:opacity-50"
                      >
                        {m.departments.every((d) => d.status !== "active") ? "Enable" : "Disable"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invitations && invitations.length > 0 && (
        <div className="mt-8">
          <h2 className="text-[17px] font-semibold text-ink">Pending invitations</h2>
          <p className="mt-1.5 text-[14px] text-muted">
            Sent but not yet accepted. Resend or revoke them from the department's Members tab.
          </p>
          <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-surface-muted">
                  <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                    Email
                  </th>
                  <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                    Department &amp; role
                  </th>
                  <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                    Expires
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invite) => (
                  <tr key={invite.id} className="border-b border-line-muted last:border-b-0">
                    <td className="px-6 py-4">
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-medium text-ink">{invite.email}</span>
                        {invite.isExpired && <StatusPill tone="warning">Expired</StatusPill>}
                      </span>
                      <span className="mt-0.5 block text-[13px] text-subtle">
                        invited by {invite.invitedBy}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-[14px] text-muted">
                      {invite.departmentName} · {invite.roleName}
                    </td>
                    <td className="px-6 py-4 text-[14px] text-muted">
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="mt-8 text-[13.5px] text-subtle">
        People are invited to a specific department and role, from that department's Members tab.
      </p>
    </AppShell>
  );
}
