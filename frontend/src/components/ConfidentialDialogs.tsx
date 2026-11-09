import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { primaryButtonBase, secondaryButtonBase, StatusPill } from "./AuthCard";
import { Select } from "./Select";
import { LockIcon, XIcon } from "./icons";
import { ApiRequestError } from "../lib/api";
import { fetchOrgUsers } from "../lib/sharing";
import {
  addConfidentialMember,
  approveRecovery,
  fetchConfidentialMembers,
  fetchOrphanedVaults,
  fetchRecoveries,
  initiateRecovery,
  removeConfidentialMember,
} from "../lib/confidential";

/** Add-people control: an org-user dropdown that appends to a chip list. Excludes anyone already
 *  picked (and any explicit exclusions, e.g. the current user). */
export function PeoplePicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
}) {
  const { data: users = [] } = useQuery({ queryKey: ["org-users"], queryFn: fetchOrgUsers, retry: false });
  const chosen = new Set([...selected, ...exclude]);
  const available = users.filter((u) => !chosen.has(u.id));
  const label = (id: string) => users.find((u) => u.id === id)?.fullName ?? "Unknown";

  return (
    <div>
      <Select
        value=""
        onChange={(id) => id && onChange([...selected, id])}
        placeholder={available.length ? "Add a person…" : "No more people to add"}
        ariaLabel="Add a person"
        options={available.map((u) => ({ value: u.id, label: u.fullName, hint: u.email }))}
      />
      {selected.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {selected.map((id) => (
            <span key={id} className="flex items-center gap-1.5 rounded-full bg-primary-tint px-2.5 py-1 text-[12.5px] font-medium text-primary">
              {label(id)}
              <button type="button" onClick={() => onChange(selected.filter((x) => x !== id))} aria-label={`Remove ${label(id)}`}>
                <XIcon size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Manage a confidential folder's named list ─────────────────────────────────

export function ConfidentialManageDialog({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["confidential-members", folderId],
    queryFn: () => fetchConfidentialMembers(folderId),
    retry: false,
  });
  const { data: users = [] } = useQuery({ queryKey: ["org-users"], queryFn: fetchOrgUsers, retry: false });

  const memberIds = new Set((data?.members ?? []).map((m) => m.userId));
  const addable = users.filter((u) => !memberIds.has(u.id));
  // Only the owner manages the list; everyone else on it sees who has access, read-only.
  const canManage = data?.canManage === true;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["confidential-members", folderId] });

  const add = useMutation({
    mutationFn: (userId: string) => addConfidentialMember(folderId, userId),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Couldn't add."),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeConfidentialMember(folderId, userId),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Couldn't remove."),
  });

  return (
    <Modal title="Confidential access" subtitle={data?.folderName} onClose={onClose}>
      <p className="mb-4 text-[13px] text-subtle">
        Access is this named list only — roles grant nothing here, and the owner can't be removed.
        {data && !canManage && " Only the owner can add or remove people."}
      </p>

      {isLoading ? (
        <p className="text-[13.5px] text-subtle">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {(data?.members ?? []).map((m) => (
            <li key={m.userId} className="flex items-center gap-3 rounded-xl border border-line-muted px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-ink">{m.fullName}</p>
                <p className="truncate text-[12.5px] text-subtle">{m.email}</p>
              </div>
              {m.isOwner ? (
                <StatusPill tone="primary">Owner</StatusPill>
              ) : canManage && (
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(m.userId)}
                  className="rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger-tint disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 border-t border-line-muted pt-4">
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Add someone</label>
          <Select
            value=""
            onChange={(id) => id && add.mutate(id)}
            disabled={add.isPending}
            placeholder={addable.length ? "Choose a person…" : "Everyone's already added"}
            ariaLabel="Add a member"
            options={addable.map((u) => ({ value: u.id, label: u.fullName, hint: u.email }))}
          />
        </div>
      )}
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </Modal>
  );
}

// ── Dual-control recovery of orphaned vaults (Super Admin / Department Admin) ──

export function ConfidentialRecoveryDialog({ departmentId, onClose }: { departmentId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({}); // folderId -> chosen new-member id

  const { data: orphaned = [], isLoading } = useQuery({
    queryKey: ["orphaned-vaults", departmentId],
    queryFn: () => fetchOrphanedVaults(departmentId),
    retry: false,
  });
  const { data: recoveries = [] } = useQuery({
    queryKey: ["recoveries", departmentId],
    queryFn: () => fetchRecoveries(departmentId),
    retry: false,
  });
  const { data: users = [] } = useQuery({ queryKey: ["org-users"], queryFn: fetchOrgUsers, retry: false });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["orphaned-vaults", departmentId] });
    void queryClient.invalidateQueries({ queryKey: ["recoveries", departmentId] });
  };

  const start = useMutation({
    mutationFn: ({ folderId, userId }: { folderId: string; userId: string }) =>
      initiateRecovery(departmentId, folderId, userId),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Couldn't start recovery."),
  });
  const approve = useMutation({
    mutationFn: (recoveryId: string) => approveRecovery(departmentId, recoveryId),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Couldn't approve."),
  });

  // Folders that already have a pending recovery shouldn't also show the "start" form.
  const pendingFolderIds = new Set(recoveries.map((r) => r.folderId));
  const startable = orphaned.filter((o) => !pendingFolderIds.has(o.folderId));

  return (
    <Modal title="Confidential recovery" subtitle="Reopen an orphaned vault — needs two approvers" onClose={onClose}>
      <p className="mb-4 text-[13px] text-subtle">
        An orphaned confidential folder (no members left) can only be reopened by a Super Admin and a
        Department Admin acting together. Every step is logged.
      </p>

      {isLoading ? (
        <p className="text-[13.5px] text-subtle">Loading…</p>
      ) : (
        <>
          {recoveries.length > 0 && (
            <div className="mb-5">
              <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">In progress</h4>
              <ul className="space-y-2">
                {recoveries.map((r) => (
                  <li key={r.id} className="rounded-xl border border-line-muted px-3.5 py-3">
                    <div className="flex items-center gap-2">
                      <LockIcon size={14} className="text-accent" />
                      <span className="flex-1 truncate text-[14px] font-medium text-ink">{r.folderName}</span>
                    </div>
                    <p className="mt-1 text-[12.5px] text-subtle">
                      Grants access to <span className="font-medium text-ink">{r.newMemberName}</span>
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <StatusPill tone={r.superAdminApproved ? "success" : "warning"}>
                        Super Admin {r.superAdminApproved ? "✓" : "…"}
                      </StatusPill>
                      <StatusPill tone={r.deptAdminApproved ? "success" : "warning"}>
                        Dept Admin {r.deptAdminApproved ? "✓" : "…"}
                      </StatusPill>
                      <button
                        type="button"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(r.id)}
                        className={`${primaryButtonBase} ml-auto px-4 py-1.5`}
                      >
                        Approve
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Orphaned vaults</h4>
          {startable.length === 0 ? (
            <p className="text-[13.5px] text-subtle">No orphaned confidential folders.</p>
          ) : (
            <ul className="space-y-2">
              {startable.map((o) => (
                <li key={o.folderId} className="rounded-xl border border-line-muted px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <LockIcon size={14} className="text-accent" />
                    <span className="flex-1 truncate text-[14px] font-medium text-ink">{o.folderName}</span>
                  </div>
                  <div className="mt-2.5 flex items-end gap-2">
                    <div className="flex-1">
                      <label className="mb-1.5 block text-[12px] text-subtle">Grant access to</label>
                      <Select
                        value={pick[o.folderId] ?? ""}
                        onChange={(id) => setPick((p) => ({ ...p, [o.folderId]: id }))}
                        placeholder="Choose a person…"
                        ariaLabel="New member"
                        options={users.map((u) => ({ value: u.id, label: u.fullName, hint: u.email }))}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!pick[o.folderId] || start.isPending}
                      onClick={() => {
                        const userId = pick[o.folderId];
                        if (userId) start.mutate({ folderId: o.folderId, userId });
                      }}
                      className={`${secondaryButtonBase} px-4 py-2.5`}
                    >
                      Start recovery
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </Modal>
  );
}

// ── shared modal shell ────────────────────────────────────────────────────────

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg animate-card-in rounded-2xl border border-line bg-surface shadow-card-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <LockIcon size={20} />
            </span>
            <div>
              <h2 className="text-[17px] font-bold tracking-[-0.3px] text-ink">{title}</h2>
              {subtitle && <p className="truncate text-[13px] text-subtle">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
