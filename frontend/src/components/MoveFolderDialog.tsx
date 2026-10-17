import { useMemo, useState, type ReactNode } from "react";
import { primaryButtonBase, secondaryButtonBase } from "./AuthCard";
import { CheckIcon, FolderIcon, FolderMoveIcon, GridIcon, LockIcon, XIcon } from "./icons";
import { ApiRequestError } from "../lib/api";
import { moveFolder, type FolderNode } from "../lib/folders";

/**
 * Re-nest a folder under another folder, or at the top of the department (FLD-4). Destinations the
 * server would refuse stay visible but disabled with the reason, so the choice is never a guess:
 * the folder itself and its own subfolders, where it already sits, anything that would push its
 * deepest subfolder past the depth limit, and a place already holding a folder of the same name.
 * Permissions re-resolve from the new parent on the server — nothing is copied.
 */
export function MoveFolderDialog({
  departmentId,
  departmentName,
  folder,
  folders,
  depthLimit,
  onClose,
  onMoved,
}: {
  departmentId: string;
  departmentName: string;
  folder: FolderNode;
  /** The caller's visible folder tree — confidential folders they aren't named on are never in it. */
  folders: FolderNode[];
  depthLimit: number | null;
  onClose: () => void;
  onMoved: (parentFolderId: string | null) => void;
}) {
  // undefined = nothing chosen yet; null = the top level of the department.
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The folder and everything under it — it can't move into its own branch.
  const branch = useMemo(() => {
    const ids = new Set([folder.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentFolderId && ids.has(f.parentFolderId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    return ids;
  }, [folder.id, folders]);

  // Levels the branch spans below the folder: the move must keep its deepest folder within the limit.
  const branchHeight = useMemo(
    () => Math.max(0, ...folders.filter((f) => branch.has(f.id)).map((f) => f.depth - folder.depth)),
    [branch, folders, folder.depth],
  );

  // Depth-first, alphabetical — the list reads like the sidebar tree.
  const ordered = useMemo(() => {
    const out: FolderNode[] = [];
    const walk = (parentId: string | null) => {
      folders
        .filter((f) => f.parentFolderId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((f) => {
          out.push(f);
          walk(f.id);
        });
    };
    walk(null);
    return out;
  }, [folders]);

  function blockedReason(parentId: string | null, parentDepth: number): string | null {
    if (parentId === folder.parentFolderId) return "Current location";
    if (parentId && branch.has(parentId)) return parentId === folder.id ? "This folder" : "Inside this folder";
    const newDepth = parentId === null ? 0 : parentDepth + 1;
    if (depthLimit != null && newDepth + branchHeight > depthLimit) return "Too deep";
    const nameTaken = folders.some(
      (f) => f.parentFolderId === parentId && f.id !== folder.id && f.name === folder.name,
    );
    if (nameTaken) return "Already has a folder with this name";
    return null;
  }

  const targetFolder = target ? folders.find((f) => f.id === target) : undefined;
  const becomesConfidential = !folder.isConfidential && targetFolder?.isConfidential === true;

  async function move() {
    if (target === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await moveFolder(departmentId, folder.id, target);
      onMoved(target);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't move the folder.");
      setBusy(false);
    }
  }

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
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <FolderMoveIcon size={20} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-bold tracking-[-0.3px] text-ink">Move folder</h2>
              <p className="truncate text-[13px] text-subtle">
                {folder.name}
                {branch.size > 1 ? ` and its ${branch.size - 1} subfolder${branch.size === 2 ? "" : "s"}` : ""} ·
                choose where it goes
              </p>
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

        <div className="max-h-[60vh] overflow-y-auto px-3 py-3" role="radiogroup" aria-label="Destination">
          <Destination
            label={`Top level of ${departmentName}`}
            icon={<GridIcon size={15} />}
            indent={0}
            selected={target === null}
            reason={blockedReason(null, -1)}
            onSelect={() => setTarget(null)}
          />
          {ordered.map((f) => (
            <Destination
              key={f.id}
              label={f.name}
              icon={f.isConfidential ? <LockIcon size={14} /> : <FolderIcon size={15} />}
              indent={f.depth + 1}
              selected={target === f.id}
              reason={blockedReason(f.id, f.depth)}
              onSelect={() => setTarget(f.id)}
            />
          ))}
        </div>

        <div className="border-t border-line px-6 py-4">
          {becomesConfidential && (
            <p className="mb-3 flex items-start gap-2 rounded-lg bg-warning-tint px-3 py-2.5 text-[13px] text-warning">
              <LockIcon size={14} className="mt-0.5 shrink-0" />
              Moving into a confidential folder makes this folder confidential too: only that folder's
              named people will see it, and moving it out later won't undo that.
            </p>
          )}
          {folder.isConfidential && (
            <p className="mb-3 text-[13px] text-subtle">This folder stays confidential wherever it goes.</p>
          )}
          {error && <p className="mb-3 text-[13px] font-medium text-danger">{error}</p>}
          <div className="flex justify-end gap-2.5">
            <button type="button" onClick={onClose} className={`${secondaryButtonBase} px-5`}>
              Cancel
            </button>
            <button
              type="button"
              disabled={target === undefined || busy}
              onClick={() => void move()}
              className={`${primaryButtonBase} px-5`}
            >
              {busy ? "Moving…" : "Move here"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Destination({
  label,
  icon,
  indent,
  selected,
  reason,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
  indent: number;
  selected: boolean;
  reason: string | null;
  onSelect: () => void;
}) {
  const disabled = reason !== null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={{ paddingLeft: `${12 + indent * 18}px` }}
      className={`flex w-full items-center gap-2.5 rounded-lg py-2.5 pr-3 text-left text-[14px] transition-colors ${
        selected
          ? "bg-primary-tint font-semibold text-primary"
          : disabled
            ? "cursor-not-allowed text-subtle"
            : "text-ink hover:bg-surface-muted"
      }`}
    >
      <span className={selected ? "text-primary" : "text-subtle"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <CheckIcon size={15} />}
      {reason && <span className="shrink-0 text-[12px] font-normal text-subtle">{reason}</span>}
    </button>
  );
}
