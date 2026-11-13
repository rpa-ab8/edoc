import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inputBase, primaryButtonBase, secondaryButtonBase, StatusPill } from "./AuthCard";
import { Select } from "./Select";
import { CheckIcon, CopyIcon, TrashIcon, UsersIcon, XIcon } from "./icons";
import { ApiRequestError } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { fetchDepartment } from "../lib/departments";
import { useAuthStore } from "../store/authStore";
import {
  createShare,
  expiryLabel,
  fetchDocumentShares,
  fetchOrgUsers,
  revokeShare,
  updateShare,
  type ShareStatus,
  type SharePermission,
  type ShareView,
} from "../lib/sharing";

const STATUS_TONE: Record<ShareStatus, "success" | "warning" | "danger" | "primary"> = {
  active: "success",
  pending: "warning",
  revoked: "danger",
  expired: "danger",
};

/**
 * The share dialog. Internal sharing and external links are two visually separate zones with a
 * divider, because they carry different risk (Feature Spec §7.1). Internal sharing reaches any
 * person in the organization — any department — by name (bug 1); there is no whole-department
 * target. The external zone appears only when the caller holds the external-share permission.
 */
export function ShareDialog({
  documentId,
  departmentId,
  permissions,
  onClose,
}: {
  documentId: string;
  departmentId: string;
  permissions: Record<string, boolean>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const myUserId = useAuthStore((s) => s.user?.id);
  const canExternal =
    permissions["sharing.external_share"] === true && permissions["sharing.create_link"] === true;

  const { data: shares = [], isLoading: sharesLoading } = useQuery({
    queryKey: ["document-shares", documentId],
    queryFn: () => fetchDocumentShares(documentId),
    retry: false,
  });
  const { data: users = [] } = useQuery({
    queryKey: ["org-users"],
    queryFn: fetchOrgUsers,
    retry: false,
  });
  // Only to read this department's external-links rule, so the external zone can guide the user when
  // it's turned off rather than simply vanishing (bug 4).
  const { data: department } = useQuery({
    queryKey: ["department-detail", departmentId],
    queryFn: () => fetchDepartment(departmentId),
    enabled: canExternal,
    retry: false,
  });
  const externalEnabled = department?.rules?.defaultSharing?.externalLinksEnabled ?? false;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["document-shares", documentId] });
  // Shares revoked in this session — lets the external zone stop displaying a link that no longer works.
  const [revokedIds, setRevokedIds] = useState<ReadonlySet<string>>(new Set());
  const markRevoked = (id: string) => setRevokedIds((prev) => new Set(prev).add(id));

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
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <UsersIcon size={20} />
            </span>
            <div>
              <h2 className="text-[17px] font-bold tracking-[-0.3px] text-ink">Share document</h2>
              <p className="text-[13px] text-subtle">Access is by reference — revoke any time.</p>
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

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          <InternalZone
            documentId={documentId}
            users={users.filter((u) => u.id !== myUserId)}
            onDone={refresh}
          />

          {canExternal && (
            <ExternalZone documentId={documentId} enabled={externalEnabled} revokedIds={revokedIds} onDone={refresh} />
          )}

          <section className="mt-7 border-t border-line-muted pt-5">
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
              Current access
            </h3>
            {sharesLoading ? (
              <p className="text-[13.5px] text-subtle">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-[13.5px] text-subtle">Not shared with anyone yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {shares.map((s) => (
                  <ShareRow key={s.id} share={s} onChanged={refresh} onRevoked={markRevoked} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Internal sharing — to any person in the organization ──────────────────────

function InternalZone({
  documentId,
  users,
  onDone,
}: {
  documentId: string;
  users: { id: string; fullName: string; email: string }[];
  onDone: () => void;
}) {
  const [targetUserId, setTargetUserId] = useState("");
  const [permission, setPermission] = useState<SharePermission>("view");
  const [expiryDays, setExpiryDays] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createShare(documentId, {
        targetType: "user",
        targetUserId,
        permission,
        expiresInDays: expiryDays.trim() === "" ? null : Number(expiryDays),
      }),
    onSuccess: () => {
      setTargetUserId("");
      setExpiryDays("");
      setError(null);
      onDone();
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't share."),
  });

  return (
    <section>
      <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
        Share with a person
      </h3>

      <Select
        value={targetUserId}
        onChange={setTargetUserId}
        placeholder={users.length ? "Choose a person…" : "No other people in this organization"}
        ariaLabel="Recipient"
        options={users.map((u) => ({ value: u.id, label: u.fullName, hint: u.email }))}
      />

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Access</label>
          <Select
            className="w-40"
            value={permission}
            onChange={(v) => setPermission(v as SharePermission)}
            ariaLabel="Permission"
            options={[
              { value: "view", label: "View only" },
              { value: "download", label: "View & download" },
            ]}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Expires (days)</label>
          <input
            type="number"
            min={1}
            max={365}
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            placeholder="Never"
            className={`${inputBase} w-28`}
          />
        </div>
        <button
          type="button"
          disabled={!targetUserId || mutation.isPending}
          onClick={() => mutation.mutate()}
          className={`${primaryButtonBase} px-5 py-2.5`}
        >
          {mutation.isPending ? "Sharing…" : "Share"}
        </button>
      </div>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </section>
  );
}

// ── External secure link ──────────────────────────────────────────────────────

function ExternalZone({
  documentId,
  enabled,
  revokedIds,
  onDone,
}: {
  documentId: string;
  enabled: boolean;
  revokedIds: ReadonlySet<string>;
  onDone: () => void;
}) {
  const [permission, setPermission] = useState<SharePermission>("view");
  const [expiryDays, setExpiryDays] = useState("7");
  const [created, setCreated] = useState<{ shareId: string; url: string } | null>(null);
  const linkUrl = created && !revokedIds.has(created.shareId) ? created.url : null;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createShare(documentId, {
        targetType: "external_link",
        permission,
        expiresInDays: expiryDays.trim() === "" ? undefined : Number(expiryDays),
      }),
    onSuccess: (res) => {
      setCreated(res.linkUrl ? { shareId: res.share.id, url: res.linkUrl } : null);
      setError(null);
      onDone();
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't create a link."),
  });

  async function copy() {
    if (!linkUrl) return;
    if (!(await copyText(linkUrl))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="mt-7 border-t border-line-muted pt-5">
      <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
        External secure link
      </h3>
      <p className="mb-3 text-[12.5px] text-subtle">
        Opens for someone without an account. Always expires; every open is logged.
      </p>

      {!enabled ? (
        <div className="rounded-lg border border-dashed border-line bg-surface-muted px-3.5 py-3 text-[12.5px] text-subtle">
          External links are turned off for this department. A department admin can enable them under
          the department's <span className="font-medium text-ink">Rules</span> tab.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Access</label>
              <Select
                className="w-40"
                value={permission}
                onChange={(v) => setPermission(v as SharePermission)}
                ariaLabel="Link permission"
                options={[
                  { value: "view", label: "View only" },
                  { value: "download", label: "View & download" },
                ]}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Expires (days)</label>
              <input
                type="number"
                min={1}
                max={365}
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
                className={`${inputBase} w-28`}
              />
            </div>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className={`${secondaryButtonBase} px-5 py-2.5`}
            >
              {mutation.isPending ? "Creating…" : "Create link"}
            </button>
          </div>

          {linkUrl && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2">
              <input
                readOnly
                value={linkUrl}
                className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none"
              />
              <button
                type="button"
                onClick={copy}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium text-primary hover:bg-primary-tint"
              >
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
        </>
      )}
    </section>
  );
}

// ── A single existing share, with revoke / permission change (SHR-6) ───────────

function ShareRow({
  share,
  onChanged,
  onRevoked,
}: {
  share: ShareView;
  onChanged: () => void;
  onRevoked: (shareId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const live = share.status === "active" || share.status === "pending";

  const icon = share.targetType === "external_link" ? "🔗" : "👤";

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  // Optimistically drop the row on a successful revoke so the action feels immediate (bug 8).
  if (revoked) return null;

  return (
    <li className="rounded-xl border border-line-muted px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span aria-hidden>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{share.targetLabel}</span>
        <StatusPill tone={STATUS_TONE[share.status]}>{share.status}</StatusPill>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
        <span>{expiryLabel(share.expiresAt)}</span>
        {share.targetType === "external_link" && <span>· Opened {share.openedCount}×</span>}
      </div>

      {live && (
        <div className="mt-2.5 flex items-center gap-2">
          <Select
            className="w-40"
            value={share.permission}
            onChange={(v) => void run(() => updateShare(share.id, { permission: v as SharePermission }))}
            disabled={busy}
            ariaLabel="Change access"
            options={[
              { value: "view", label: "View only" },
              { value: "download", label: "View & download" },
            ]}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await revokeShare(share.id);
                setRevoked(true);
                onRevoked(share.id);
              })
            }
            className="ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger-tint disabled:opacity-50"
          >
            <TrashIcon size={13} /> Revoke
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
    </li>
  );
}
