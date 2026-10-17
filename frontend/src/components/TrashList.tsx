import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { primaryButtonBase, secondaryButtonBase } from "./AuthCard";
import { FileTypeIcon } from "./FileTypeIcon";
import { RefreshIcon, TrashIcon } from "./icons";
import { ApiRequestError } from "../lib/api";
import { emptyTrash, fetchTrash, purgeDocument, restoreDocument, type TrashItem } from "../lib/documents";

function countdownLabel(days: number): { text: string; urgent: boolean } {
  if (days <= 0) return { text: "Removing soon", urgent: true };
  if (days === 1) return { text: "1 day left", urgent: true };
  return { text: `${days} days left`, urgent: days <= 5 };
}

/**
 * The department's trash (TRSH-2/3). Anyone with restore rights sees it and can restore; only a
 * Department Admin gets "Empty trash" and per-item permanent delete, both behind a hard confirm.
 */
export function TrashList({ departmentId, canPurge }: { departmentId: string; canPurge: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: items = [], isLoading, error: loadError } = useQuery({
    queryKey: ["trash", departmentId],
    queryFn: () => fetchTrash(departmentId),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["trash", departmentId] });

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  const empty = useMutation({
    mutationFn: () => emptyTrash(departmentId),
    onSuccess: () => { setConfirmingEmpty(false); setError(null); refresh(); },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't empty the trash."),
  });

  if (isLoading) return <p className="text-[14px] text-subtle">Loading…</p>;
  if (loadError) {
    return (
      <p className="text-[14px] text-subtle">
        {loadError instanceof ApiRequestError && loadError.status === 403
          ? "You don't have permission to view the trash for this department."
          : "Couldn't load the trash."}
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-ink">Trash</h2>
        <span className="text-[13.5px] text-subtle">
          {items.length} item{items.length === 1 ? "" : "s"} · auto-removed after 30 days
        </span>
        {canPurge && items.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {confirmingEmpty ? (
              <>
                <span className="text-[13px] text-danger">Permanently delete everything?</span>
                <button
                  type="button"
                  disabled={empty.isPending}
                  onClick={() => empty.mutate()}
                  className="rounded-lg bg-danger px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90"
                >
                  {empty.isPending ? "Emptying…" : "Empty trash"}
                </button>
                <button type="button" onClick={() => setConfirmingEmpty(false)} className={`${secondaryButtonBase} px-3.5 py-2`}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingEmpty(true)}
                className={`${secondaryButtonBase} flex items-center gap-2 px-4 py-2 text-danger`}
              >
                <TrashIcon size={15} /> Empty trash
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-[13px] text-danger">{error}</p>}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-14 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-subtle">
            <TrashIcon size={22} />
          </span>
          <p className="mt-5 text-[16px] font-semibold text-ink">Trash is empty</p>
          <p className="mt-1.5 text-[14px] text-subtle">Deleted documents wait here before they're gone for good.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-surface-muted">
                <th className="px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Document</th>
                <th className="hidden px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle md:table-cell">Origin</th>
                <th className="hidden px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle md:table-cell">Deleted by</th>
                <th className="px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Auto-remove</th>
                <th className="px-5 py-3.5 text-right" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <TrashRow key={it.id} item={it} canPurge={canPurge} busy={busyId === it.id} onAct={act} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrashRow({
  item,
  canPurge,
  busy,
  onAct,
}: {
  item: TrashItem;
  canPurge: boolean;
  busy: boolean;
  onAct: (id: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const countdown = countdownLabel(item.daysUntilAutoRemove);

  return (
    <tr className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/50">
      <td className="px-5 py-3.5">
        <div className="flex items-start gap-3">
          <FileTypeIcon mimeType={item.mimeType} fileName={item.fileName} className="mt-0.5 h-9 w-9" />
          <div className="min-w-0">
            <span className="plate px-2 py-0.5 text-[12px]">{item.documentRef}</span>
            <span className="mt-1 block truncate text-[14px] font-medium text-ink">{item.titleValue ?? item.fileName ?? "Untitled"}</span>
          </div>
        </div>
      </td>
      <td className="hidden px-5 py-3.5 text-[14px] text-muted md:table-cell">{item.originFolderName}</td>
      <td className="hidden px-5 py-3.5 text-[14px] text-muted md:table-cell">{item.deletedByName ?? "—"}</td>
      <td className="px-5 py-3.5">
        <span className={`text-[13px] font-medium ${countdown.urgent ? "text-danger" : "text-muted"}`}>{countdown.text}</span>
        {item.retentionLocked && <span className="ml-2 text-[12px] text-warning">Locked</span>}
      </td>
      <td className="px-5 py-3.5 text-right">
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={busy || item.retentionLocked}
            onClick={() => void onAct(item.id, () => restoreDocument(item.id))}
            className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-primary hover:underline disabled:opacity-40"
          >
            <RefreshIcon size={14} /> Restore
          </button>
          {canPurge &&
            (confirmingPurge ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || item.retentionLocked}
                  onClick={() => void onAct(item.id, () => purgeDocument(item.id)).then(() => setConfirmingPurge(false))}
                  className={`${primaryButtonBase} bg-danger px-3 py-1.5 shadow-none`}
                >
                  Delete forever
                </button>
                <button type="button" onClick={() => setConfirmingPurge(false)} className="text-[13px] text-subtle hover:text-ink">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy || item.retentionLocked}
                onClick={() => setConfirmingPurge(true)}
                title={item.retentionLocked ? "Under a retention lock" : "Delete permanently"}
                className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-danger hover:underline disabled:opacity-40"
              >
                <TrashIcon size={14} /> Delete forever
              </button>
            ))}
        </div>
      </td>
    </tr>
  );
}
