import { useEffect, useRef, useState } from "react";
import { primaryButtonBase, secondaryButtonBase } from "../AuthCard";
import { Select } from "../Select";
import { MetadataFields, type FieldValues } from "./MetadataFields";
import {
  ACCEPTED_UPLOAD_ACCEPT,
  ACCEPTED_UPLOAD_EXTENSIONS,
  duplicatesFromError,
  humanFileSize,
  uploadDocument,
  type DuplicateMatch,
  type DuplicateResolution,
} from "../../lib/documents";
import { ApiRequestError } from "../../lib/api";
import type { DraftDocumentType, DraftField } from "../../lib/departments";
import { CopyButton } from "../CopyButton";
import { FileTypeIcon } from "../FileTypeIcon";
import {
  CheckCircleIcon,
  DocumentIcon,
  FolderIcon,
  TrashIcon,
  UploadCloudIcon,
  XIcon,
} from "../icons";

type DocType = DraftDocumentType & { id: string };
export interface FolderOption {
  id: string;
  name: string;
  depth: number;
}

type ItemStatus = "ready" | "uploading" | "done" | "skipped" | "duplicate" | "error";

interface UploadItem {
  key: string;
  file: File;
  title: string; // per-file value for the type's title field
  status: ItemStatus;
  message?: string;
  ref?: string; // the assigned document ID on success
  duplicates?: DuplicateMatch[];
}

let counter = 0;
const nextKey = () => `f${++counter}`;

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function extensionOk(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return ACCEPTED_UPLOAD_EXTENSIONS.includes(ext);
}

/**
 * The upload experience (UPL-1..5). A destination folder (documents always live in one — so it's
 * chosen here, defaulting to wherever the upload was started), one document type per batch, a
 * shared metadata form applied to every file (the "shared-fields bar"), and a per-file title so
 * each document gets its own name. Files upload independently, so one file needing attention never
 * blocks the rest; a content duplicate pauses just that file and offers add-as-new-version /
 * keep-both / skip.
 */
export function UploadPanel({
  departmentId,
  folders,
  initialFolderId,
  subject,
  documentTypes,
  initialFiles = [],
  onClose,
  onUploaded,
}: {
  departmentId: string;
  folders: FolderOption[];
  initialFolderId?: string | null;
  subject: string;
  documentTypes: DocType[];
  initialFiles?: File[];
  /** `filedToFolderId` is the folder the most recent file landed in, so the caller can take the user
   *  there — otherwise a file sent to a different folder than the one open looks like it vanished. */
  onClose: (filedToFolderId?: string) => void;
  onUploaded: () => void;
}) {
  const [folderId, setFolderId] = useState(initialFolderId ?? folders[0]?.id ?? "");
  const [filedToFolderId, setFiledToFolderId] = useState<string | undefined>(undefined);
  const close = () => onClose(filedToFolderId);
  const [typeId, setTypeId] = useState(documentTypes[0]?.id ?? "");
  const [shared, setShared] = useState<FieldValues>({});
  const [items, setItems] = useState<UploadItem[]>(() => initialFiles.map(toItem));
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The batch of rows just added, to bring into view once they're on screen.
  const [reveal, setReveal] = useState<{ first: string; last: string } | null>(null);

  // New rows land at the bottom of the list, below the shared-details form — often past the bottom
  // of the panel's scroll area, so a picked file looked like it hadn't arrived. Scroll just enough
  // to show the new batch, keeping its first row in view if the whole batch doesn't fit.
  useEffect(() => {
    const body = bodyRef.current;
    if (!reveal || !body) return;
    const row = (key: string) => body.querySelector<HTMLElement>(`[data-item-key="${key}"]`);
    const first = row(reveal.first);
    const last = row(reveal.last);
    if (!first || !last) return;
    const view = body.getBoundingClientRect();
    const top = first.getBoundingClientRect().top - view.top;
    const bottom = last.getBoundingClientRect().bottom - view.bottom;
    const margin = 12;
    let delta = 0;
    if (bottom > -margin) delta = Math.min(bottom + margin, top - margin);
    else if (top < margin) delta = top - margin;
    if (delta === 0) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    body.scrollBy({ top: delta, behavior: reduceMotion ? "auto" : "smooth" });
  }, [reveal]);

  const type = documentTypes.find((t) => t.id === typeId);
  const titleField: DraftField | undefined = type?.fields.find((f) => f.isTitle);
  const folderName = folders.find((f) => f.id === folderId)?.name;

  const readyCount = items.filter((i) => i.status === "ready").length;
  const doneCount = items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const anyResolved = doneCount > 0;
  const hasTypes = documentTypes.length > 0;
  const hasFolders = folders.length > 0;
  const canSubmit = hasTypes && hasFolders && Boolean(folderId);

  function addFiles(list: FileList | File[]) {
    // Copy the files out *now*. A FileList is live: the picker's onChange clears the input right
    // after this call (so the same file can be picked twice), which empties the list — and React
    // may run a state updater later, at render time, rather than immediately. Reading the list
    // inside the updater then found zero files, which is how a picked file "didn't arrive" after
    // the destination folder had been changed. Drag-and-drop lists go stale the same way.
    const added = Array.from(list).map(toItem);
    if (added.length === 0) return;
    setItems((prev) => [...prev, ...added]);
    setReveal({ first: added[0]!.key, last: added[added.length - 1]!.key });
  }
  function patch(key: string, changes: Partial<UploadItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...changes } : i)));
  }

  function fieldValuesFor(item: UploadItem) {
    if (!type) return [];
    const values: { fieldDefId: string; value: string }[] = [];
    for (const field of type.fields) {
      if (!field.id) continue;
      const raw = field.isTitle ? item.title : (shared[field.id] ?? "");
      const value = raw.trim();
      if (value !== "") values.push({ fieldDefId: field.id, value });
    }
    return values;
  }

  async function uploadOne(item: UploadItem, resolution?: DuplicateResolution, duplicateOfDocumentId?: string) {
    if (!type || !folderId) return;
    const targetFolderId = folderId;
    const targetName = folders.find((f) => f.id === targetFolderId)?.name;
    patch(item.key, { status: "uploading", message: undefined });
    try {
      const result = await uploadDocument(departmentId, folderId, {
        documentTypeId: type.id,
        fieldValues: fieldValuesFor(item),
        file: item.file,
        onDuplicate: resolution,
        duplicateOfDocumentId,
      });
      if (result.action === "skipped") {
        patch(item.key, { status: "skipped", message: "Skipped — not uploaded" });
      } else if (result.action === "new_version") {
        // A new version joins the existing document wherever that lives — not necessarily here.
        patch(item.key, { status: "done", ref: result.document?.documentRef, message: "Added as a new version" });
      } else {
        patch(item.key, {
          status: "done",
          ref: result.document?.documentRef,
          message: targetName ? `Filed in ${targetName}` : undefined,
        });
        setFiledToFolderId(targetFolderId);
      }
      onUploaded();
    } catch (err) {
      const duplicates = duplicatesFromError(err);
      if (duplicates.length > 0) {
        patch(item.key, { status: "duplicate", duplicates });
      } else {
        patch(item.key, {
          status: "error",
          message: err instanceof ApiRequestError ? err.message : "Upload failed",
        });
      }
    }
  }

  async function uploadAll() {
    if (!canSubmit) return;
    setBusy(true);
    // Sequential so progress reads clearly and the server isn't hit with a burst; each file is
    // still an independent request, so one failure never stops the others.
    for (const item of items) {
      if (item.status !== "ready") continue;
      await uploadOne(item);
    }
    setBusy(false);
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={close}
    >
      <div
        className="w-full max-w-2xl animate-card-in rounded-2xl border border-line bg-surface shadow-card-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <UploadCloudIcon size={20} />
            </span>
            <div>
              <h2 className="text-[17px] font-bold tracking-[-0.3px] text-ink">Add {subject}</h2>
              <p className="text-[13px] text-subtle">{folderName ? `to ${folderName}` : "choose a folder below"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-lg p-2 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        </header>

        <div ref={bodyRef} className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {!hasTypes ? (
            <EmptyNote
              title="No document types yet"
              body="A document needs a type to define its metadata. Create one in the department's settings, then upload here."
            />
          ) : !hasFolders ? (
            <EmptyNote
              title="No folders yet"
              body="Documents live inside folders. Create a folder first, then add documents to it."
            />
          ) : (
            <>
              {/* Destination + type sit side by side: where the file goes, and what it is. */}
              <div className="mb-5 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-ink">Folder</label>
                  <Select
                    value={folderId}
                    ariaLabel="Destination folder"
                    className="w-full"
                    options={folders.map((f) => ({
                      value: f.id,
                      label: `${"  ".repeat(f.depth)}${f.name}`,
                    }))}
                    onChange={setFolderId}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-ink">Document type</label>
                  {documentTypes.length === 1 ? (
                    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-muted px-3.5 py-2.5">
                      <DocumentIcon size={17} className="text-primary" />
                      <span className="text-[14.5px] font-medium text-ink">{type?.name}</span>
                      <span className="plate ml-auto px-2 py-0.5">{type?.idCode}</span>
                    </div>
                  ) : (
                    <Select
                      value={typeId}
                      ariaLabel="Document type"
                      className="w-full"
                      options={documentTypes.map((t) => ({ value: t.id, label: t.name, hint: t.idCode }))}
                      onChange={(v) => {
                        setTypeId(v);
                        setShared({}); // fields differ per type
                      }}
                    />
                  )}
                </div>
              </div>

              {/* Drop zone */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
                }}
                className={`flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors ${
                  dragging ? "border-primary bg-primary-tint" : "border-line hover:border-primary/50 hover:bg-surface-muted/60"
                }`}
              >
                <UploadCloudIcon size={26} className="text-primary" />
                <p className="mt-2.5 text-[14.5px] font-medium text-ink">
                  Drop files here, or <span className="text-primary">browse</span>
                </p>
                <p className="mt-1 text-[12.5px] text-subtle">PDF, JPG, PNG, DOCX, XLSX · up to 120MB each</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPTED_UPLOAD_ACCEPT}
                  className="hidden"
                  // The input sits inside the drop zone, whose onClick opens it — without this its
                  // own click bubbles back up and asks to open the picker a second time.
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>

              {/* Shared metadata — applied to every file (UPL-3). Title is per-file, below. */}
              {type && items.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2.5 text-[13px] font-semibold text-ink">
                    {items.length > 1 ? "Details applied to all files" : "Details"}
                    <span className="ml-2 font-normal text-subtle">optional — complete later if you like</span>
                  </p>
                  <MetadataFields
                    fields={type.fields}
                    values={shared}
                    onChange={(id, value) => setShared((prev) => ({ ...prev, [id]: value }))}
                    omitFieldIds={titleField?.id ? [titleField.id] : []}
                  />
                </div>
              )}

              {/* File list */}
              {items.length > 0 && (
                <ul className="mt-5 space-y-2.5">
                  {items.map((item) => (
                    <li
                      key={item.key}
                      data-item-key={item.key}
                      className="animate-fade-up rounded-xl border border-line bg-surface px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <FileTypeIcon mimeType={item.file.type} fileName={item.file.name} className="h-9 w-9" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-medium text-ink">{item.file.name}</p>
                          <p className="text-[12px] text-subtle">{humanFileSize(item.file.size)}</p>
                        </div>
                        <StatusChip item={item} />
                        {item.status === "ready" && (
                          <button
                            type="button"
                            aria-label={`Remove ${item.file.name}`}
                            onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                            className="rounded-md p-1.5 text-subtle transition-colors hover:bg-danger-tint hover:text-danger"
                          >
                            <TrashIcon size={15} />
                          </button>
                        )}
                      </div>

                      {/* Per-file title (each document gets its own name) */}
                      {titleField && (item.status === "ready" || item.status === "error") && (
                        <div className="mt-2.5 flex items-center gap-2 pl-12">
                          <label className="text-[12.5px] text-subtle">{titleField.label}</label>
                          <input
                            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13.5px] text-ink focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15"
                            value={item.title}
                            placeholder="Document name"
                            onChange={(e) => patch(item.key, { title: e.target.value })}
                          />
                        </div>
                      )}

                      {item.message && item.status !== "duplicate" && (
                        <p className={`mt-2 pl-12 text-[12.5px] ${item.status === "error" ? "text-danger" : "text-subtle"}`}>
                          {item.message}
                        </p>
                      )}

                      {item.status === "duplicate" && item.duplicates && (
                        <DuplicatePrompt
                          matches={item.duplicates}
                          onResolve={(res, docId) => void uploadOne(item, res, docId)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <p className="text-[13px] text-subtle">
            {doneCount > 0 && `${doneCount} filed`}
            {doneCount > 0 && readyCount > 0 && " · "}
            {readyCount > 0 && `${readyCount} ready`}
          </p>
          <div className="flex gap-2.5">
            <button type="button" onClick={close} className={`${secondaryButtonBase} px-5`}>
              {anyResolved && readyCount === 0 ? "Done" : "Cancel"}
            </button>
            {hasTypes && hasFolders && (
              <button
                type="button"
                onClick={() => void uploadAll()}
                disabled={busy || readyCount === 0 || !canSubmit}
                className={`${primaryButtonBase} px-5`}
              >
                {busy ? "Uploading…" : `Upload ${readyCount || ""} file${readyCount === 1 ? "" : "s"}`.trim()}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );

  function toItem(file: File): UploadItem {
    const item: UploadItem = { key: nextKey(), file, title: baseName(file.name), status: "ready" };
    if (!extensionOk(file.name)) {
      item.status = "error";
      item.message = `Unsupported type — accepted: ${ACCEPTED_UPLOAD_EXTENSIONS.join(", ")}`;
    }
    return item;
  }
}

function EmptyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl bg-surface-muted px-4 py-8 text-center">
      <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface text-subtle">
        <FolderIcon size={20} />
      </span>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-[13.5px] text-subtle">{body}</p>
    </div>
  );
}

function StatusChip({ item }: { item: UploadItem }) {
  if (item.status === "uploading")
    return <span className="text-[12.5px] font-medium text-primary">Uploading…</span>;
  if (item.status === "done")
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-success">
        <CheckCircleIcon size={15} />
        {item.ref ? (
          <>
            <span className="plate px-1.5 py-0.5 text-[11.5px]">{item.ref}</span>
            <CopyButton text={item.ref!} className="p-0.5" />
          </>
        ) : (
          "Filed"
        )}
      </span>
    );
  if (item.status === "skipped")
    return <span className="text-[12.5px] font-medium text-subtle">Skipped</span>;
  if (item.status === "duplicate")
    return <span className="text-[12.5px] font-medium text-warning">Already exists</span>;
  if (item.status === "error")
    return <span className="text-[12.5px] font-medium text-danger">Error</span>;
  return <span className="text-[12.5px] text-subtle">Ready</span>;
}

function DuplicatePrompt({
  matches,
  onResolve,
}: {
  matches: DuplicateMatch[];
  onResolve: (resolution: DuplicateResolution, duplicateOfDocumentId?: string) => void;
}) {
  const primary = matches[0];
  return (
    <div className="mt-2.5 rounded-lg bg-warning-tint px-3.5 py-3">
      <p className="text-[13px] font-medium text-warning">
        This file already exists as <span className="font-mono">{primary?.documentRef}</span>
        {primary?.titleValue ? ` — ${primary.titleValue}` : ""}.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onResolve("new_version", primary?.documentId)}
          className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-primary-dark"
        >
          Add as new version
        </button>
        <button
          type="button"
          onClick={() => onResolve("keep_both")}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted"
        >
          Keep both
        </button>
        <button
          type="button"
          onClick={() => onResolve("skip")}
          className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-subtle transition-colors hover:text-ink"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
