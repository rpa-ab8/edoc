import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { primaryButtonBase, secondaryButtonBase } from "../components/AuthCard";
import { FileTypeIcon } from "../components/FileTypeIcon";
import { MetadataFields, type FieldValues } from "../components/upload/MetadataFields";
import { LegalHoldBadge, PlaceHoldDialog } from "../components/LegalHold";
import {
  CheckCircleIcon,
  ChevronLeftIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  HoldIcon,
  PencilIcon,
  RefreshIcon,
  TrashIcon,
  UploadCloudIcon,
  UsersIcon,
} from "../components/icons";
import { ShareDialog } from "../components/ShareDialog";
import { ApiRequestError } from "../lib/api";
import { fetchDepartment } from "../lib/departments";
import {
  ACCEPTED_UPLOAD_ACCEPT,
  deleteDocument,
  downloadDocumentFile,
  editDocumentMetadata,
  fetchDocument,
  fetchDocumentActivity,
  fetchPreviewObjectUrl,
  fetchPreviewText,
  humanFileSize,
  isPreviewable,
  restoreDocumentVersion,
  uploadNewVersion,
  type DocumentDetail,
} from "../lib/documents";
import { LazyMarkdownView } from "../components/LazyMarkdownView";
import { placeDocumentHold, removeLegalHold } from "../lib/retention";
import { useAuthStore } from "../store/authStore";

const ACTION_LABEL: Record<string, string> = {
  view: "viewed",
  upload: "uploaded a version",
  download: "downloaded",
  edit: "edited the metadata",
  restore: "restored a version",
  delete: "deleted",
  share: "shared",
  link_access: "opened a link",
  auto_delete: "auto-deleted it — retention period ended",
  legal_hold_placed: "placed a Legal Hold",
  legal_hold_removed: "lifted a Legal Hold",
};

function whenLabel(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

export function DocumentViewerPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<FieldValues>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Markdown / plain-text files are previewed from their text, not an object URL.
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const myName = useAuthStore((s) => s.user?.fullName ?? "You");

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => fetchDocument(documentId),
    enabled: Boolean(documentId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const perms = doc?.permissions ?? {};
  const canDownload = perms["documents.download"] === true;
  const canPreview = perms["documents.preview"] === true;
  const canEdit = perms["documents.edit_metadata"] === true;
  const canVersion = perms["documents.upload_version"] === true;
  const canShare = perms["sharing.share"] === true;
  const canDelete = perms["documents.delete"] === true;
  // A view-only share recipient (or a minimal role) sees just the document, its metadata and the
  // preview — no version history and no activity feed. Those are gated on the same permission that
  // governs seeing the version chain (bug 3).
  const canSeeHistory = perms["documents.version_history"] === true;
  // Legal Hold (RET-5/6): a held document can't be deleted, so Delete isn't offered at all.
  const hold = doc?.legalHold;
  const held = hold?.held === true;
  const canManageHold = hold?.canManage === true;

  const currentVersion = doc?.versions.find((v) => v.id === doc.currentVersionId) ?? doc?.versions.at(-1);
  const previewType = isPreviewable(currentVersion?.mimeType);

  // The type's full field defs (with options) — only needed to *edit* metadata.
  const { data: department } = useQuery({
    queryKey: ["department-detail", doc?.departmentId],
    queryFn: () => fetchDepartment(doc!.departmentId!),
    enabled: editing && Boolean(doc?.departmentId),
    retry: false,
  });
  const docType = department?.documentTypes.find((t) => t.id === doc?.documentType.id);

  // Fetch the preview bytes (as an object URL) for the current version, and revoke on change/unmount.
  // Keyed on ids, not objects, so a metadata-only edit doesn't re-download the file.
  const docId = doc?.id;
  const currentVersionId = currentVersion?.id;
  useEffect(() => {
    if (!docId || !currentVersionId || !canPreview || !previewType) {
      setPreviewUrl(null);
      setPreviewText(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewFailed(false);
    if (previewType === "markdown" || previewType === "text") {
      setPreviewUrl(null);
      fetchPreviewText(docId, currentVersionId)
        .then((text) => {
          if (!cancelled) setPreviewText(text);
        })
        .catch(() => setPreviewFailed(true))
        .finally(() => setPreviewLoading(false));
      return () => {
        cancelled = true;
      };
    }
    setPreviewText(null);
    fetchPreviewObjectUrl(docId, currentVersionId)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setPreviewUrl(url);
      })
      .catch(() => setPreviewFailed(true))
      .finally(() => setPreviewLoading(false));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, currentVersionId, canPreview, previewType]);

  // After an action, take the updated document from the action's own response and refresh only the
  // activity feed. Re-fetching GET /documents/:id would log a fresh `view` on every edit/restore/
  // version upload, padding the audit trail with views nobody made.
  async function run(work: () => Promise<DocumentDetail | void>, okText: string) {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await work();
      const activity = await fetchDocumentActivity(documentId).catch(() => undefined);
      queryClient.setQueryData<DocumentDetail>(["document", documentId], (prev) =>
        prev
          ? { ...prev, ...(updated ?? {}), permissions: prev.permissions, activity: activity ?? prev.activity }
          : prev,
      );
      setMessage({ text: okText, ok: true });
    } catch (err) {
      setMessage({ text: err instanceof ApiRequestError ? err.message : "Something went wrong.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  function startEditing() {
    if (!doc) return;
    const values: FieldValues = {};
    for (const fv of doc.fieldValues) if (fv.fieldDefId) values[fv.fieldDefId] = fv.value;
    setEditValues(values);
    setEditing(true);
  }
  function saveMetadata() {
    void run(async () => {
      const fieldValues = Object.entries(editValues)
        .filter(([, v]) => v.trim() !== "")
        .map(([fieldDefId, value]) => ({ fieldDefId, value: value.trim() }));
      const updated = await editDocumentMetadata(documentId, fieldValues);
      setEditing(false);
      return updated;
    }, "Metadata saved.");
  }
  async function onVersionFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await run(async () => (await uploadNewVersion(documentId, file)).document, "New version uploaded.");
  }

  // Back returns to wherever the document was opened from — a search, a quick view, or a folder —
  // by stepping back in history. Only when the viewer was reached directly (no in-app history, e.g.
  // a pasted link) does it fall back to the document's own folder.
  function goBack() {
    if (location.key !== "default") navigate(-1);
    // A share recipient isn't told the home folder, so they return to their own start page.
    else if (doc?.departmentId && doc.folderId) navigate(`/w/${doc.departmentId}/f/${doc.folderId}`);
    else navigate("/");
  }

  if (isLoading) return <div className="p-10 text-[14.5px] text-muted">Opening document…</div>;
  if (error || !doc) {
    return (
      <div className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="text-[22px] font-bold tracking-[-0.4px] text-ink">Document not found</h1>
        <p className="mt-3 text-[15px] text-muted">
          It may have been moved or deleted, or you may not have access to it.
        </p>
        <Link to="/" className={`${secondaryButtonBase} mt-6 inline-block px-6`}>
          Back to workspace
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface/95 px-6 py-3.5 backdrop-blur">
        <button
          type="button"
          onClick={goBack}
          className="flex items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-primary"
        >
          <ChevronLeftIcon size={16} /> Back
        </button>
        <div className="ml-1 flex min-w-0 items-center gap-2.5">
          <FileTypeIcon mimeType={currentVersion?.mimeType} fileName={currentVersion?.fileName} className="h-8 w-8" iconSize={16} />
          <span className="truncate text-[15px] font-semibold text-ink">
            {doc.titleValue ?? currentVersion?.fileName ?? "Untitled"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {canShare && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className={`${secondaryButtonBase} flex items-center gap-2 px-4 py-2`}
            >
              <UsersIcon size={15} /> Share
            </button>
          )}
          {canDelete && !held && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                deleteDocument(doc.id)
                  .then(() => goBack())
                  .catch((err) =>
                    setMessage({ text: err instanceof ApiRequestError ? err.message : "Couldn't delete.", ok: false }),
                  )
                  .finally(() => setBusy(false));
              }}
              title="Move to trash (recoverable)"
              className={`${secondaryButtonBase} flex items-center gap-2 px-4 py-2 text-danger hover:bg-danger-tint`}
            >
              <TrashIcon size={15} /> Delete
            </button>
          )}
          {canVersion && (
            <button
              type="button"
              disabled={busy}
              onClick={() => versionInputRef.current?.click()}
              className={`${secondaryButtonBase} flex items-center gap-2 px-4 py-2`}
            >
              <UploadCloudIcon size={15} /> New version
            </button>
          )}
          {canDownload && currentVersion && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void downloadDocumentFile(doc.id, currentVersion.id, currentVersion.fileName)}
              className={`${primaryButtonBase} flex items-center gap-2 px-4 py-2`}
            >
              <DownloadIcon size={15} /> Download
            </button>
          )}
        </div>
        <input
          ref={versionInputRef}
          type="file"
          className="hidden"
          accept={ACCEPTED_UPLOAD_ACCEPT}
          onChange={(e) => void onVersionFile(e)}
        />
      </header>

      {message && (
        <div className={`px-6 py-2.5 text-[13.5px] font-medium ${message.ok ? "text-success" : "text-danger"}`}>
          {message.text}
        </div>
      )}

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Preview */}
        <main className="min-w-0 flex-1 bg-surface-inset p-6">
          {!canPreview ? (
            <PreviewMessage title="Preview not permitted" body="Your role can open this document's details but not its file preview." />
          ) : !previewType ? (
            <PreviewMessage
              title="No inline preview for this file type"
              body={canDownload ? "Download the file to open it in its native app." : "This file type can't be previewed here."}
            />
          ) : previewLoading ? (
            <PreviewMessage title="Loading preview…" body="" />
          ) : previewFailed || (!previewUrl && previewText === null) ? (
            <PreviewMessage title="Couldn't load the preview" body="The file may be unavailable in storage." />
          ) : previewType === "markdown" || previewType === "text" ? (
            <div className="h-[82vh] overflow-auto rounded-lg border border-line bg-surface px-8 py-7 shadow-card">
              {previewType === "markdown" ? (
                <LazyMarkdownView source={previewText ?? ""} />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13.5px] leading-relaxed text-ink">{previewText}</pre>
              )}
            </div>
          ) : !previewUrl ? (
            <PreviewMessage title="Couldn't load the preview" body="The file may be unavailable in storage." />
          ) : previewType === "image" ? (
            <div className="flex h-full items-center justify-center">
              <img src={previewUrl} alt={doc.titleValue ?? "Document preview"} className="max-h-[80vh] max-w-full rounded-lg border border-line bg-surface shadow-card" />
            </div>
          ) : (
            // Without documents.download, hide the browser PDF viewer's own download/print toolbar
            // (VUE-5). A deterrent, not a guarantee — previewed bytes are on the client.
            <iframe
              title="Document preview"
              src={canDownload ? previewUrl : `${previewUrl}#toolbar=0&navpanes=0`}
              className="h-[82vh] w-full rounded-lg border border-line bg-surface"
            />
          )}
        </main>

        {/* Details */}
        <aside className="w-full shrink-0 border-t border-line bg-surface px-6 py-6 lg:w-[400px] lg:border-l lg:border-t-0">
          {/* Document ID — the header of the details panel */}
          <div className="flex items-center gap-2">
            <span className="plate px-2.5 py-1 text-[13px]">{doc.documentRef}</span>
            <button
              type="button"
              aria-label="Copy document ID"
              title="Copy ID"
              onClick={() => void navigator.clipboard?.writeText(doc.documentRef)}
              className="rounded p-1.5 text-subtle transition-colors hover:bg-surface-muted hover:text-primary"
            >
              <CopyIcon size={14} />
            </button>
          </div>
          <p className="mt-2 text-[13px] text-subtle">
            {doc.documentType.name} · Uploaded{" "}
            {new Date(doc.uploadedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          </p>

          {/* Legal Hold (RET-5) — the badge for everyone; the reasons and controls for those who manage holds. */}
          {held && (
            <section className="mt-5 rounded-xl border border-warning/25 bg-warning-tint/60 px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <LegalHoldBadge />
                <span className="text-[12.5px] text-warning">Can't be deleted while held</span>
              </div>
              {hold!.holds.length > 0 && (
                <ul className="mt-3 space-y-3">
                  {hold!.holds.map((h) => (
                    <li key={h.id} className="text-[13px] leading-relaxed">
                      <p className="font-medium text-ink">{h.reason}</p>
                      <p className="text-subtle">
                        {h.scope === "folder" ? `On the folder "${h.folderName}" · ` : ""}
                        {h.placedByName} · {new Date(h.placedAt).toLocaleDateString()}
                      </p>
                      {h.scope === "document" && canManageHold && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await removeLegalHold(h.id);
                              queryClient.setQueryData<DocumentDetail>(["document", documentId], (prev) => {
                                if (!prev?.legalHold) return prev;
                                const holds = prev.legalHold.holds.filter((x) => x.id !== h.id);
                                return { ...prev, legalHold: { ...prev.legalHold, holds, held: holds.length > 0 } };
                              });
                            }, "Legal Hold lifted.")
                          }
                          className="mt-1 text-[12.5px] font-semibold text-warning hover:underline"
                        >
                          Lift hold
                        </button>
                      )}
                      {h.scope === "folder" && canManageHold && (
                        <p className="mt-0.5 text-[12px] text-subtle">Lift it from the folder.</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {canManageHold && !hold!.holds.some((h) => h.scope === "document") && (
            <button
              type="button"
              onClick={() => setHoldOpen(true)}
              className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-warning hover:underline"
            >
              <HoldIcon size={14} /> Place Legal Hold
            </button>
          )}

          {/* Metadata */}
          <section className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Details</h2>
              {canEdit && !editing && (
                <button type="button" onClick={startEditing} className="flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
                  <PencilIcon size={13} /> Edit
                </button>
              )}
            </div>

            {editing ? (
              docType ? (
                <div>
                  <MetadataFields fields={docType.fields} values={editValues} onChange={(id, v) => setEditValues((p) => ({ ...p, [id]: v }))} columns={1} />
                  <div className="mt-4 flex gap-2.5">
                    <button type="button" disabled={busy} onClick={saveMetadata} className={`${primaryButtonBase} px-5`}>
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button type="button" onClick={() => setEditing(false)} className={`${secondaryButtonBase} px-5`}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[13.5px] text-subtle">Loading fields…</p>
              )
            ) : doc.fieldValues.length > 0 ? (
              <dl className="space-y-2.5">
                {doc.fieldValues.map((fv) => (
                  <div key={fv.fieldDefId ?? fv.label} className="flex justify-between gap-4">
                    <dt className="text-[13.5px] text-subtle">{fv.label}</dt>
                    <dd className="text-right text-[13.5px] font-medium text-ink">{fv.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-[13.5px] text-subtle">No metadata yet{canEdit ? " — add some with Edit." : "."}</p>
            )}
          </section>

          {/* Version history — hidden for a view-only recipient */}
          {canSeeHistory && (
          <section className="mt-7 border-t border-line-muted pt-6">
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Version history</h2>
            <ul className="space-y-2">
              {[...doc.versions].reverse().map((v) => (
                <li key={v.id} className="rounded-xl border border-line-muted px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-semibold text-ink">v{v.versionNumber}</span>
                    {v.isCurrent && (
                      <span className="rounded bg-primary-tint px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-primary">Current</span>
                    )}
                    <span className="ml-auto text-[12px] text-subtle">{humanFileSize(v.fileSize)}</span>
                  </div>
                  <p className="mt-1 truncate text-[13px] text-muted">{v.fileName}</p>
                  <p className="mt-0.5 text-[12px] text-subtle">
                    {v.uploadedBy?.fullName ?? "Someone"} · {whenLabel(v.createdAt)}
                    {v.changeNote ? ` · ${v.changeNote}` : ""}
                  </p>
                  {canVersion && !v.isCurrent && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => restoreDocumentVersion(documentId, v.id), `Restored v${v.versionNumber}.`)}
                      className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"
                    >
                      <RefreshIcon size={13} /> Restore this version
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          )}

          {/* Activity — member-only, hidden for a view-only recipient */}
          {canSeeHistory && (
          <section className="mt-7 border-t border-line-muted pt-6">
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Activity</h2>
            {doc.activity && doc.activity.length > 0 ? (
              <ul className="space-y-2.5">
                {doc.activity.slice(0, 12).map((a) => (
                  <li key={a.id} className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-subtle">
                      {a.action === "download" ? <DownloadIcon size={13} /> : a.action === "view" ? <ClockIcon size={13} /> : <CheckCircleIcon size={13} />}
                    </span>
                    <p className="text-[13px] leading-snug text-muted">
                      <span className="font-medium text-ink">{a.actorName}</span> {ACTION_LABEL[a.action] ?? a.action}
                      <span className="text-subtle"> · {whenLabel(a.occurredAt)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13.5px] text-subtle">No activity recorded yet.</p>
            )}
          </section>
          )}
        </aside>
      </div>

      {shareOpen && doc.departmentId && (
        <ShareDialog
          documentId={doc.id}
          departmentId={doc.departmentId}
          permissions={perms}
          onClose={() => setShareOpen(false)}
        />
      )}
      {holdOpen && (
        <PlaceHoldDialog
          target="document"
          subject={`${doc.documentRef} · ${doc.titleValue ?? currentVersion?.fileName ?? "Untitled"}`}
          onClose={() => setHoldOpen(false)}
          onPlace={async (reason) => {
            const { hold: placed } = await placeDocumentHold(doc.id, reason);
            // Update in place rather than re-fetching: a re-fetch would log a view nobody made.
            queryClient.setQueryData<DocumentDetail>(["document", documentId], (prev) =>
              prev?.legalHold
                ? {
                    ...prev,
                    legalHold: {
                      ...prev.legalHold,
                      held: true,
                      holds: [
                        ...prev.legalHold.holds,
                        { id: placed.id, scope: "document", folderId: null, folderName: null, reason: placed.reason, placedAt: placed.placedAt, placedByName: myName },
                      ],
                    },
                  }
                : prev,
            );
            const activity = await fetchDocumentActivity(documentId).catch(() => undefined);
            if (activity) queryClient.setQueryData<DocumentDetail>(["document", documentId], (prev) => (prev ? { ...prev, activity } : prev));
            setMessage({ text: "Legal Hold placed.", ok: true });
          }}
        />
      )}
    </div>
  );
}

function PreviewMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1.5 max-w-xs text-[13.5px] text-subtle">{body}</p>}
    </div>
  );
}
