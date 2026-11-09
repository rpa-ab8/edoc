import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inputBase, primaryButtonBase, secondaryButtonBase } from "../AuthCard";
import { CalendarIcon, ClockIcon, DocumentIcon, FolderIcon, HoldIcon, TrashIcon, XIcon } from "../icons";
import { LegalHoldBadge, PlaceHoldDialog } from "../LegalHold";
import { ApiRequestError } from "../../lib/api";
import {
  daysBetween,
  fetchAutoDeleteSetting,
  fetchLegalHolds,
  fetchUpcomingDeletions,
  formatCalendarDate,
  placeDocumentHold,
  previewAutoDelete,
  previewFromError,
  removeLegalHold,
  saveAutoDeletePeriod,
  type AutoDeletePreview,
  type UpcomingDeletion,
} from "../../lib/retention";

const CARD = "rounded-2xl border border-line bg-surface shadow-card";
const TH = "px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle";

/**
 * The department's Retention tab (PRD v1.2 RET-1..8), for Department Admins. Each card appears only
 * for someone holding its right; the server enforces every rule regardless.
 *
 *  - Auto-delete: the period in whole years, off by default. Setting or shortening it shows how many
 *    documents the next daily run would move to Trash and asks for an explicit confirmation first.
 *  - Upcoming deletions: what the daily run will move in the next 30 days, soonest first, with a
 *    Legal Hold one click away. Held documents stay listed, marked, so a new hold visibly lands.
 *  - Legal holds: every active hold in the department, and lifting one.
 */
export function RetentionPanel({
  departmentId,
  canManageAutoDelete,
  canViewUpcoming,
  canManageHolds,
}: {
  departmentId: string;
  canManageAutoDelete: boolean;
  canViewUpcoming: boolean;
  canManageHolds: boolean;
}) {
  return (
    <div className="max-w-4xl space-y-6">
      {canManageAutoDelete && <AutoDeleteCard departmentId={departmentId} />}
      {canViewUpcoming && <UpcomingCard departmentId={departmentId} />}
      {canManageHolds && <HoldsCard departmentId={departmentId} />}
    </div>
  );
}

// ─────────────────────────── auto-delete period ───────────────────────────

function AutoDeleteCard({ departmentId }: { departmentId: string }) {
  const queryClient = useQueryClient();
  const { data: setting, refetch } = useQuery({
    queryKey: ["retention", departmentId],
    queryFn: () => fetchAutoDeleteSetting(departmentId),
  });
  const [enabled, setEnabled] = useState(false);
  const [years, setYears] = useState("7");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AutoDeletePreview | null>(null);

  useEffect(() => {
    if (!setting) return;
    setEnabled(setting.autoDeleteYears !== null);
    if (setting.autoDeleteYears !== null) setYears(String(setting.autoDeleteYears));
  }, [setting]);

  if (!setting) return <div className={`${CARD} p-7 text-[14px] text-subtle`}>Loading auto-delete…</div>;

  const current = setting.autoDeleteYears;
  const parsed = Number(years);
  const yearsValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100;
  const proposed = enabled ? (yearsValid ? parsed : null) : null;
  const dirty = enabled ? yearsValid && parsed !== current : current !== null;

  const refreshAll = () =>
    Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ["upcoming-deletions", departmentId] }),
      queryClient.invalidateQueries({ queryKey: ["department", departmentId] }),
    ]);

  async function save(confirm: boolean) {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await saveAutoDeletePeriod(departmentId, proposed, confirm);
      setConfirming(null);
      await refreshAll();
      setStatus(
        proposed === null
          ? "Auto-delete is off. Nothing will be deleted automatically from now on."
          : `Auto-delete is set to ${proposed} year${proposed === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      const preview = previewFromError(err);
      if (preview) setConfirming(preview);
      else setError(err instanceof ApiRequestError ? err.message : "Couldn't save the auto-delete period.");
    } finally {
      setSaving(false);
    }
  }

  // Setting or shortening asks the server for the count first; the server would refuse an
  // unconfirmed save anyway, so this is the same safety rendered before the click rather than after.
  async function onSave() {
    if (enabled && !yearsValid) {
      setError("Enter a whole number of years from 1 to 100.");
      return;
    }
    const needsConfirm = proposed !== null && (current === null || proposed < current);
    if (!needsConfirm) return save(false);
    setSaving(true);
    setError(null);
    try {
      setConfirming(await previewAutoDelete(departmentId, proposed));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't check what this would delete.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${CARD} p-7`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.2px] text-ink">
            <ClockIcon size={18} className="text-subtle" /> Auto-delete
          </h3>
          <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-muted">
            Moves documents to Trash once they are older than the period, counted from each document's
            Upload Date — including documents uploaded before this was switched on. Trash keeps them for
            30 days, then removes them permanently. Documents under a Legal Hold are never deleted.
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] ${
            current === null ? "bg-surface-muted text-muted" : "bg-primary-tint text-primary"
          }`}
        >
          {current === null ? "Off" : `On · ${current} yr${current === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-5">
        <div>
          <span className="mb-2 block text-[13.5px] font-medium text-ink">Auto-delete</span>
          <div role="radiogroup" aria-label="Auto-delete" className="inline-flex rounded-lg border border-line bg-surface-muted p-1">
            {[
              { on: false, label: "Off" },
              { on: true, label: "After a period" },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                role="radio"
                aria-checked={enabled === opt.on}
                onClick={() => {
                  setEnabled(opt.on);
                  setStatus(null);
                  setError(null);
                }}
                className={`rounded-md px-4 py-2 text-[14px] font-medium transition-colors ${
                  enabled === opt.on ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {enabled && (
          <div>
            <label htmlFor="auto-delete-years" className="mb-2 block text-[13.5px] font-medium text-ink">
              Period
            </label>
            <div className="flex items-center gap-2.5">
              <input
                id="auto-delete-years"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                value={years}
                onChange={(e) => setYears(e.target.value)}
                className={`${inputBase} w-28 font-mono`}
              />
              <span className="text-[14.5px] text-muted">years after upload</span>
            </div>
          </div>
        )}
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void onSave()}
          className={`${primaryButtonBase} ml-auto px-6`}
        >
          {saving ? "Checking…" : "Save"}
        </button>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line-muted pt-5 text-[13px] text-subtle">
        <span className="flex items-center gap-1.5">
          <CalendarIcon size={14} /> Runs daily at {setting.schedule.time} ({setting.schedule.timeZone})
        </span>
        <span>
          Next run: <span className="font-medium text-muted">{formatCalendarDate(setting.nextRunDate)}</span>
        </span>
        <span>Switching off stops future deletions; it can't bring back anything already removed.</span>
      </div>

      {status && <p className="mt-4 text-[14px] font-medium text-success">{status}</p>}
      {error && <p className="mt-4 text-[14px] font-medium text-danger">{error}</p>}

      {confirming && (
        <ConfirmPeriodDialog
          preview={confirming}
          busy={saving}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void save(true)}
        />
      )}
    </section>
  );
}

function ConfirmPeriodDialog({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: AutoDeletePreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const years = preview.autoDeleteYears ?? 0;
  const shortening = preview.currentYears !== null;
  const count = preview.affectedCount;
  const noun = `document${count === 1 ? "" : "s"}`;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-period-title"
        className="w-full max-w-lg animate-card-in rounded-2xl border border-line bg-surface shadow-card-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-tint text-danger">
              <TrashIcon size={19} />
            </span>
            <div>
              <h2 id="confirm-period-title" className="text-[17px] font-bold tracking-[-0.3px] text-ink">
                {shortening ? `Shorten auto-delete to ${years} years?` : `Turn on auto-delete after ${years} years?`}
              </h2>
              <p className="text-[13px] text-subtle">
                {shortening ? `Currently ${preview.currentYears} years` : "Currently off"} · applies to every document
                in this department
              </p>
            </div>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close" className="rounded-lg p-2 text-subtle hover:bg-surface-muted hover:text-ink">
            <XIcon size={16} />
          </button>
        </header>

        <div className="px-6 py-6">
          <div className={`rounded-xl px-5 py-4 ${count > 0 ? "bg-danger-tint" : "bg-surface-muted"}`}>
            <p className={`font-mono text-[34px] font-semibold leading-none tracking-[-1px] ${count > 0 ? "text-danger" : "text-ink"}`}>
              {count.toLocaleString()}
            </p>
            <p className={`mt-2 text-[14.5px] font-medium ${count > 0 ? "text-danger" : "text-muted"}`}>
              {noun} will be moved to Trash at the next daily run ({formatCalendarDate(preview.nextRunDate)}).
            </p>
          </div>
          <p className="mt-4 text-[14px] leading-relaxed text-muted">
            They stay recoverable in Trash for 30 days, then are permanently removed. Documents under a Legal
            Hold are skipped. To keep a document, place a hold on it before the run.
          </p>
          {count > 0 && (
            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-line px-4 py-3">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#DC2626]"
              />
              <span className="text-[14px] text-ink">
                I understand {count.toLocaleString()} {noun} will be moved to Trash and, after 30 days, permanently
                deleted.
              </span>
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2.5 border-t border-line px-6 py-4">
          <button type="button" onClick={onCancel} className={`${secondaryButtonBase} px-5`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (count > 0 && !understood)}
            onClick={onConfirm}
            // Red only when this will actually delete something. Not `primaryButtonBase` + `bg-danger`:
            // two bg utilities of equal specificity resolve by stylesheet order, and primary won.
            className={
              count > 0
                ? "rounded-lg bg-danger px-5 py-2.5 text-center text-[14.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
                : `${primaryButtonBase} px-5`
            }
          >
            {busy ? "Saving…" : shortening ? `Shorten to ${years} years` : `Turn on — ${years} years`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── upcoming deletions ───────────────────────────

function UpcomingCard({ departmentId }: { departmentId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["upcoming-deletions", departmentId],
    queryFn: () => fetchUpcomingDeletions(departmentId),
    retry: false,
  });
  const [holding, setHolding] = useState<UpcomingDeletion | null>(null);

  const due = data?.items.filter((i) => !i.legalHold).length ?? 0;

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-4 px-7 pt-7">
        <div>
          <h3 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.2px] text-ink">
            <CalendarIcon size={18} className="text-subtle" /> Upcoming deletions
          </h3>
          <p className="mt-1.5 text-[14px] text-muted">
            Documents the daily run will move to Trash in the next 30 days, soonest first.
          </p>
        </div>
        {data && data.autoDeleteYears !== null && (
          <span className="text-[13.5px] text-subtle">
            <span className="font-semibold text-ink">{due}</span> scheduled
            {data.items.length > due && ` · ${data.items.length - due} held`}
          </span>
        )}
      </div>

      <div className="mt-5">
        {isLoading ? (
          <p className="px-7 pb-7 text-[14px] text-subtle">Loading…</p>
        ) : error ? (
          <p className="px-7 pb-7 text-[14px] text-danger">Couldn't load upcoming deletions.</p>
        ) : !data || data.autoDeleteYears === null ? (
          <EmptyState title="Auto-delete is off" body="Nothing is scheduled. Turn auto-delete on above to start a retention period." />
        ) : data.items.length === 0 ? (
          <EmptyState title="Nothing due in the next 30 days" body={`With a ${data.autoDeleteYears}-year period, no document reaches it before ${formatCalendarDate(addWindow(data.today))}.`} />
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-surface-muted">
                  <th className={TH}>Document</th>
                  <th className={`${TH} hidden md:table-cell`}>Uploaded</th>
                  <th className={TH}>Scheduled</th>
                  <th className="px-5 py-3.5" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/50">
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/documents/${item.id}`} className="plate px-2 py-0.5 text-[12px] hover:underline">
                          {item.documentRef}
                        </Link>
                        {item.legalHold && <LegalHoldBadge compact />}
                      </div>
                      <span className="mt-1 block truncate text-[14px] font-medium text-ink">{item.titleValue ?? "Untitled"}</span>
                      <span className="block text-[12.5px] text-subtle">
                        {item.documentType} · {item.folderName}
                      </span>
                    </td>
                    <td className="hidden px-5 py-3.5 text-[14px] text-muted md:table-cell">{formatCalendarDate(item.uploadDate)}</td>
                    <td className="px-5 py-3.5">
                      {item.legalHold ? (
                        <span className="text-[13.5px] font-medium text-warning">Won't be deleted while held</span>
                      ) : (
                        <ScheduledDate item={item} today={data.today} />
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {item.canManageHold && !item.legalHold && (
                        <button
                          type="button"
                          onClick={() => setHolding(item)}
                          className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13.5px] font-medium text-warning hover:underline"
                        >
                          <HoldIcon size={14} /> Place hold
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {holding && (
        <PlaceHoldDialog
          target="document"
          subject={`${holding.documentRef} · ${holding.titleValue ?? "Untitled"} — due ${formatCalendarDate(holding.scheduledDate)}`}
          onClose={() => setHolding(null)}
          onPlace={async (reason) => {
            await placeDocumentHold(holding.id, reason);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["upcoming-deletions", departmentId] }),
              queryClient.invalidateQueries({ queryKey: ["legal-holds", departmentId] }),
            ]);
          }}
        />
      )}
    </section>
  );
}

function addWindow(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 30));
  return next.toISOString().slice(0, 10);
}

function ScheduledDate({ item, today }: { item: UpcomingDeletion; today: string }) {
  const days = daysBetween(today, item.scheduledDate);
  const overdue = item.dueDate < today;
  const tone = days <= 7 ? "bg-danger-tint text-danger" : "bg-warning-tint text-warning";
  return (
    <div>
      <span className="text-[14px] font-medium text-ink">{formatCalendarDate(item.scheduledDate)}</span>
      <span className={`ml-2 inline-flex rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold ${tone}`}>
        {days <= 0 ? "Next run" : days === 1 ? "Tomorrow" : `In ${days} days`}
      </span>
      {overdue && <span className="block text-[12px] text-subtle">Period ended {formatCalendarDate(item.dueDate)}</span>}
    </div>
  );
}

// ─────────────────────────── legal holds ───────────────────────────

function HoldsCard({ departmentId }: { departmentId: string }) {
  const queryClient = useQueryClient();
  const { data: holds = [], isLoading } = useQuery({
    queryKey: ["legal-holds", departmentId],
    queryFn: () => fetchLegalHolds(departmentId),
  });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function lift(holdId: string) {
    setBusyId(holdId);
    setError(null);
    try {
      await removeLegalHold(holdId);
      setConfirmId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["legal-holds", departmentId] }),
        queryClient.invalidateQueries({ queryKey: ["upcoming-deletions", departmentId] }),
        queryClient.invalidateQueries({ queryKey: ["folders", departmentId] }),
      ]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't lift the hold.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className={CARD}>
      <div className="px-7 pt-7">
        <h3 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.2px] text-ink">
          <HoldIcon size={18} className="text-subtle" /> Legal holds
        </h3>
        <p className="mt-1.5 max-w-xl text-[14px] text-muted">
          A held document can't be deleted, auto-deleted or permanently removed from Trash. A folder hold
          covers everything inside it, including documents added later. Place holds from a document, a
          folder, the Trash, or the list above.
        </p>
      </div>
      {error && <p className="px-7 pt-4 text-[13.5px] font-medium text-danger">{error}</p>}
      <div className="mt-5">
        {isLoading ? (
          <p className="px-7 pb-7 text-[14px] text-subtle">Loading…</p>
        ) : holds.length === 0 ? (
          <EmptyState title="No active holds" body="Everything in this department follows the normal deletion rules." />
        ) : (
          <ul className="border-t border-line">
            {holds.map((h) => (
              <li key={h.id} className="flex flex-wrap items-start gap-4 border-b border-line-muted px-7 py-4 last:border-b-0">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning-tint text-warning">
                  {h.scope === "folder" ? <FolderIcon size={16} /> : <DocumentIcon size={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  {h.scope === "document" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/documents/${h.documentId}`} className="plate px-2 py-0.5 text-[12px] hover:underline">
                        {h.documentRef}
                      </Link>
                      <span className="truncate text-[14px] font-medium text-ink">{h.titleValue ?? "Untitled"}</span>
                    </div>
                  ) : (
                    <p className="text-[14px] font-medium text-ink">
                      Folder <span className="font-semibold">{h.folderName}</span>{" "}
                      <span className="font-normal text-subtle">and everything inside it</span>
                    </p>
                  )}
                  <p className="mt-1 text-[14px] text-muted">{h.reason}</p>
                  <p className="mt-0.5 text-[12.5px] text-subtle">
                    Placed by {h.placedByName} · {new Date(h.placedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                </div>
                <div className="shrink-0">
                  {confirmId === h.id ? (
                    <span className="flex items-center gap-2.5 text-[13px]">
                      <span className="text-muted">Lift this hold?</span>
                      <button
                        type="button"
                        disabled={busyId === h.id}
                        onClick={() => void lift(h.id)}
                        className="font-semibold text-warning hover:underline"
                      >
                        {busyId === h.id ? "Lifting…" : "Lift"}
                      </button>
                      <button type="button" onClick={() => setConfirmId(null)} className="text-subtle hover:text-ink">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(h.id)}
                      className="text-[13.5px] font-medium text-muted hover:text-warning hover:underline"
                    >
                      Lift hold
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {holds.length > 0 && (
        <p className="border-t border-line-muted px-7 py-3.5 text-[12.5px] text-subtle">
          Lifting a hold never deletes anything on the spot: a document already past its period goes to Trash
          at the next daily run.
        </p>
      )}
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-7 mb-7 rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="mt-1.5 text-[13.5px] text-subtle">{body}</p>
    </div>
  );
}
