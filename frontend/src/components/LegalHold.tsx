import { useEffect, useRef, useState } from "react";
import { inputBase, primaryButtonBase, secondaryButtonBase } from "./AuthCard";
import { HoldIcon, XIcon } from "./icons";
import { ApiRequestError } from "../lib/api";

/**
 * The Legal Hold badge (RET-5). Amber, because a hold is a standing condition someone must
 * consciously lift — not an error and not an action. "Inherited" says the hold sits on a folder
 * above, so the reader knows where to look to release it.
 */
export function LegalHoldBadge({ inherited = false, compact = false }: { inherited?: boolean; compact?: boolean }) {
  return (
    <span
      title={inherited ? "Covered by a Legal Hold on a folder above" : "Under a Legal Hold — it can't be deleted"}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md bg-warning-tint font-semibold text-warning ${
        compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-[12px]"
      }`}
    >
      <HoldIcon size={compact ? 12 : 13} />
      Legal Hold{inherited && !compact ? " · inherited" : ""}
    </span>
  );
}

/**
 * Place a Legal Hold on a document or a folder. A reason is mandatory (the server refuses a blank
 * one too) and is kept with the hold and in the audit log, so the dialog asks for it plainly and
 * states the consequence before anyone confirms.
 */
export function PlaceHoldDialog({
  target,
  subject,
  onClose,
  onPlace,
}: {
  target: "document" | "folder";
  /** What is being held — a document ID or a folder name, shown in the header. */
  subject: string;
  onClose: () => void;
  onPlace: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => field.current?.focus(), []);

  async function submit() {
    const text = reason.trim();
    if (!text) {
      setError("Give a reason — it is recorded with the hold and in the audit log.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onPlace(text);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't place the hold.");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hold-title"
        className="w-full max-w-lg animate-card-in rounded-2xl border border-line bg-surface shadow-card-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-tint text-warning">
              <HoldIcon size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="hold-title" className="text-[17px] font-bold tracking-[-0.3px] text-ink">
                Place a Legal Hold
              </h2>
              <p className="truncate text-[13px] text-subtle">{subject}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-subtle hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="space-y-4 px-6 py-5">
          <p className="text-[14px] leading-relaxed text-muted">
            {target === "folder"
              ? "Nothing in this folder — or in any folder inside it, including documents added later — can be deleted, auto-deleted or permanently removed from Trash until the hold is lifted."
              : "This document can't be deleted, auto-deleted or permanently removed from Trash until the hold is lifted. Viewing and editing carry on as normal."}
          </p>
          <div>
            <label htmlFor="hold-reason" className="mb-2 block text-[13.5px] font-medium text-ink">
              Reason <span className="text-danger">*</span>
            </label>
            <textarea
              id="hold-reason"
              ref={field}
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. Litigation hold — Smith v. Acme, notice dated 12 Oct"
              className={`${inputBase} w-full resize-none`}
            />
            <p className="mt-1.5 text-[12.5px] text-subtle">Kept with the hold and written to the audit log.</p>
          </div>
          {error && <p className="text-[13.5px] font-medium text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2.5 border-t border-line px-6 py-4">
          <button type="button" onClick={onClose} className={`${secondaryButtonBase} px-5`}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => void submit()} className={`${primaryButtonBase} px-5`}>
            {busy ? "Placing…" : "Place hold"}
          </button>
        </div>
      </div>
    </div>
  );
}
