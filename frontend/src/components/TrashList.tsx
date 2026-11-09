import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { primaryButtonBase, secondaryButtonBase } from "./AuthCard";
import { FileTypeIcon } from "./FileTypeIcon";
import { HoldIcon, RefreshIcon, TrashIcon } from "./icons";
import { LegalHoldBadge, PlaceHoldDialog } from "./LegalHold";
import { ApiRequestError } from "../lib/api";
import { emptyTrash, fetchTrash, purgeDocument, restoreDocument, type TrashItem } from "../lib/documents";
import { placeDocumentHold } from "../lib/retention";

function countdownLabel(days: number): { text: string; urgent: boolean } {
  if (days <= 0) return { text: "Removing soon", urgent: true };
  if (days === 1) return { text: "1 day left", urgent: true };
  return { text: `${days} days left`, urgent: days <= 5 };
}

/**
 * The department's trash (TRSH-2/3). Anyone with restore rights sees it and can restore; only a
 * Department Admin gets "Empty trash" and per-item permanent delete, both behind a hard confirm.
 *
 * PRD v1.2: items the daily auto-delete moved here say so (actor "System"), and only a Department
 * Admin may restore those (restoring places a Legal Hold). An item under a Legal Hold stays here
 * but is never permanently removed — not by a person, not by "Empty trash", not by the daily purge.
 */
export function TrashList({ departmentId, canPurge }: { departmentId: string; canPurge: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holding, setHolding] = useState<TrashItem | null>(null);

  const { data: items = [], isLoading, error: loadError } = useQuery({
    queryKey: ["trash", departmentId],
    queryFn: () => fetchTrash(departmentId),
    retry: false,
  });

  // A restore puts a document back into a folder listing, search and the needs-details queue; a purge
  // can change counts. The folder view usually stays mounted under the trash view, so it won't
  // refetch on its own — invalidate everything document-shaped for this department.
  const refresh = () =>
    Promise.all(
      [["trash", departmentId], ["documents", departmentId], ["search", departmentId], ["needs-details", departmentId]].map(
        (queryKey) => queryClient.invalidateQueries({ queryKey }),
      ),
    );

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
    onSuccess: (result) => {
      setConfirmingEmpty(false);
      setError(null);
      setNotice(
        result.skipped > 0
          ? `${result.purged} removed permanently. ${result.skipped} under a Legal Hold ${result.skipped === 1 ? "was" : "were"} kept.`
          : null,
      );
      refresh();
    },
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

  const purgeable = items.filter((it) => !it.legalHold).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-ink">Trash</h2>
        <span className="text-[13.5px] text-subtle">
          {items.length} item{items.length === 1 ? "" : "s"} · permanently removed after 30 days, unless under a Legal
          Hold
        </span>
        {canPurge && purgeable > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {confirmingEmpty ? (
              <>
                <span className="text-[13px] text-danger">
                  Permanently delete {purgeable === items.length ? "everything" : `${purgeable} item${purgeable === 1 ? "" : "s"}`}?
                  {purgeable < items.length && " Held items are kept."}
                </span>
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
      {notice && <p className="mb-3 text-[13px] font-medium text-warning">{notice}</p>}

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
                <TrashRow
                  key={it.id}
                  item={it}
                  canPurge={canPurge}
                  busy={busyId === it.id}
                  onAct={act}
                  onHold={() => setHolding(it)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {holding && (
        <PlaceHoldDialog
          target="document"
          subject={`${holding.documentRef} · ${holding.titleValue ?? holding.fileName ?? "Untitled"} — stays in Trash`}
          onClose={() => setHolding(null)}
          onPlace={async (reason) => {
            await placeDocumentHold(holding.id, reason);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function TrashRow({
  item,
  canPurge,
  busy,
  onAct,
  onHold,
}: {
  item: TrashItem;
  canPurge: boolean;
  busy: boolean;
  onAct: (id: string, fn: () => Promise<unknown>) => Promise<void>;
  onHold: () => void;
}) {
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const countdown = countdownLabel(item.daysUntilAutoRemove);
  const autoDeleted = item.trashSource === "auto_delete";

  return (
    <tr className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/50">
      <td className="px-5 py-3.5">
        <div className="flex items-start gap-3">
          <FileTypeIcon mimeType={item.mimeType} fileName={item.fileName} className="mt-0.5 h-9 w-9" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="plate px-2 py-0.5 text-[12px]">{item.documentRef}</span>
              {item.legalHold && <LegalHoldBadge compact />}
            </div>
            <span className="mt-1 block truncate text-[14px] font-medium text-ink">{item.titleValue ?? item.fileName ?? "Untitled"}</span>
            {item.trashReason && <span className="mt-0.5 block text-[12.5px] text-subtle">{item.trashReason}</span>}
          </div>
        </div>
      </td>
      <td className="hidden px-5 py-3.5 text-[14px] text-muted md:table-cell">{item.originFolderName}</td>
      <td className="hidden px-5 py-3.5 text-[14px] text-muted md:table-cell">
        {autoDeleted ? (
          <span className="inline-flex items-center rounded-md bg-surface-muted px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
            System
          </span>
        ) : (
          (item.deletedByName ?? "—")
        )}
      </td>
      <td className="px-5 py-3.5">
        {item.legalHold ? (
          <span className="text-[13px] font-medium text-warning">Kept while held</span>
        ) : (
          <span className={`text-[13px] font-medium ${countdown.urgent ? "text-danger" : "text-muted"}`}>{countdown.text}</span>
        )}
      </td>
      <td className="px-5 py-3.5 text-right">
        <div className="flex items-center justify-end gap-3">
          {item.canManageHold && !item.legalHold && (
            <button
              type="button"
              disabled={busy}
              onClick={onHold}
              title="Keep this document in Trash and stop it being permanently removed"
              className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-warning hover:underline disabled:opacity-40"
            >
              <HoldIcon size={14} /> Hold
            </button>
          )}
          <button
            type="button"
            disabled={busy || !item.canRestore}
            onClick={() => void onAct(item.id, () => restoreDocument(item.id))}
            title={
              item.canRestore
                ? autoDeleted
                  ? "Restore to its folder — a Legal Hold is placed so it isn't auto-deleted again"
                  : "Restore to its folder"
                : "Only a Department Admin can restore a document that was auto-deleted"
            }
            className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-primary hover:underline disabled:opacity-40"
          >
            <RefreshIcon size={14} /> Restore
          </button>
          {canPurge &&
            (confirmingPurge ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || item.legalHold}
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
                disabled={busy || item.legalHold}
                onClick={() => setConfirmingPurge(true)}
                title={item.legalHold ? "Under a Legal Hold — it can't be permanently deleted" : "Delete permanently"}
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
