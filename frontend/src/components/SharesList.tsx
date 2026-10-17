import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusPill } from "./AuthCard";
import {
  dismissShare,
  expiryLabel,
  fetchSharedByMe,
  fetchSharedWithMe,
  revokeShare,
  type ShareStatus,
  type ShareView,
} from "../lib/sharing";

const STATUS_TONE: Record<ShareStatus, "success" | "warning" | "danger" | "primary"> = {
  active: "success",
  pending: "warning",
  revoked: "danger",
  expired: "danger",
};

/**
 * The share list, shared by the department workspace (as a quick view, bug 2) and the org-level
 * Shares page. `with-me` is the inbox; `by-me` is the control side with revoke (SHR-6). Both span
 * every department, since a share is inherently cross-department.
 */
export function SharesList({ mode }: { mode: "with-me" | "by-me" }) {
  return mode === "with-me" ? <SharedWithMe /> : <SharedByMe />;
}

function SharedWithMe() {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data: shares = [], isLoading } = useQuery({
    queryKey: ["shared-with-me"],
    queryFn: fetchSharedWithMe,
    retry: false,
  });

  async function remove(id: string) {
    setBusyId(id);
    try {
      await dismissShare(id);
      await queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) return <p className="text-[14px] text-subtle">Loading…</p>;
  if (shares.length === 0)
    return <EmptyNote body="Nothing has been shared with you yet. Shared documents will appear here." />;

  return (
    <ShareTable
      shares={shares}
      columns={["Document", "From", "Shared by", "Access", "Status", ""]}
      renderRow={(s) => (
        <>
          <DocumentCell share={s} />
          <td className="px-5 py-3.5 text-[14px] text-muted">{s.sourceDepartmentName}</td>
          <td className="px-5 py-3.5 text-[14px] text-muted">{s.sharedByName}</td>
          <PermissionCell permission={s.permission} />
          <td className="px-5 py-3.5">
            <div className="flex items-center gap-2">
              <StatusPill tone={STATUS_TONE[s.status]}>{s.status}</StatusPill>
              <span className="text-[12.5px] text-subtle">{expiryLabel(s.expiresAt)}</span>
            </div>
          </td>
          <td className="px-5 py-3.5 text-right">
            <button
              type="button"
              disabled={busyId === s.id}
              onClick={() => void remove(s.id)}
              title="Remove from my Shared with me (doesn't affect the sharer)"
              className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted hover:bg-surface-muted hover:text-danger disabled:opacity-50"
            >
              Remove
            </button>
          </td>
        </>
      )}
    />
  );
}

function SharedByMe() {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data: shares = [], isLoading } = useQuery({
    queryKey: ["shared-by-me"],
    queryFn: fetchSharedByMe,
    retry: false,
  });

  // Drop revoked shares from view so revoke feels immediate (bug 8) — the history isn't the point of
  // this control panel.
  const visible = shares.filter((s) => s.status !== "revoked");

  async function revoke(id: string) {
    setBusyId(id);
    try {
      await revokeShare(id);
      await queryClient.invalidateQueries({ queryKey: ["shared-by-me"] });
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) return <p className="text-[14px] text-subtle">Loading…</p>;
  if (visible.length === 0)
    return <EmptyNote body="You haven't shared anything. Open a document and use Share to send it out." />;

  return (
    <ShareTable
      shares={visible}
      columns={["Document", "Shared with", "Access", "Opened", "Status", ""]}
      renderRow={(s) => (
        <>
          <DocumentCell share={s} />
          <td className="px-5 py-3.5 text-[14px] text-muted">{s.targetLabel}</td>
          <PermissionCell permission={s.permission} />
          <td className="px-5 py-3.5 text-[14px] text-muted">
            {s.targetType === "external_link" ? `${s.openedCount}×` : "—"}
          </td>
          <td className="px-5 py-3.5">
            <div className="flex items-center gap-2">
              <StatusPill tone={STATUS_TONE[s.status]}>{s.status}</StatusPill>
              <span className="text-[12.5px] text-subtle">{expiryLabel(s.expiresAt)}</span>
            </div>
          </td>
          <td className="px-5 py-3.5 text-right">
            {(s.status === "active" || s.status === "pending") && (
              <button
                type="button"
                disabled={busyId === s.id}
                onClick={() => void revoke(s.id)}
                className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-danger hover:bg-danger-tint disabled:opacity-50"
              >
                Revoke
              </button>
            )}
          </td>
        </>
      )}
    />
  );
}

function ShareTable({
  shares,
  columns,
  renderRow,
}: {
  shares: ShareView[];
  columns: string[];
  renderRow: (s: ShareView) => React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-surface-muted">
            {columns.map((c, i) => (
              <th
                key={c || i}
                className={`px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle ${
                  c === "" ? "text-right" : ""
                }`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => (
            <tr key={s.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/60">
              {renderRow(s)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocumentCell({ share }: { share: ShareView }) {
  return (
    <td className="px-5 py-3.5">
      <Link to={`/documents/${share.documentId}`} className="group block">
        <span className="plate px-2 py-0.5 text-[12px]">{share.documentRef}</span>
        <span className="mt-1 block truncate text-[14px] font-medium text-ink group-hover:text-primary">
          {share.documentTitle ?? "Untitled"}
        </span>
      </Link>
    </td>
  );
}

function PermissionCell({ permission }: { permission: "view" | "download" }) {
  return (
    <td className="px-5 py-3.5">
      <StatusPill tone={permission === "download" ? "primary" : "success"}>
        {permission === "download" ? "View & download" : "View only"}
      </StatusPill>
    </td>
  );
}

function EmptyNote({ body }: { body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-12 text-center">
      <p className="mx-auto max-w-sm text-[14px] text-subtle">{body}</p>
    </div>
  );
}
