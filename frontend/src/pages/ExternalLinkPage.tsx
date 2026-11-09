import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { primaryButtonBase } from "../components/AuthCard";
import { DownloadIcon, LockIcon } from "../components/icons";
import { LazyMarkdownView } from "../components/LazyMarkdownView";
import { isPreviewable } from "../lib/documents";
import {
  downloadExternalLinkFile,
  ExternalLinkError,
  fetchExternalLinkPreview,
  openExternalLink,
  type ExternalLinkDocument,
} from "../lib/sharing";

const ERROR_COPY: Record<string, string> = {
  link_unavailable: "This link has expired, been revoked, or never existed.",
  file_error: "The file couldn't be loaded.",
};

/**
 * The public landing for an external secure link (SHR-4). No account, no session — the token in the
 * URL is the whole credential. Opening the page records the access on the server and returns just
 * the document's identity plus what the link permits.
 */
export function ExternalLinkPage() {
  const { token = "" } = useParams();
  const [doc, setDoc] = useState<ExternalLinkDocument | null>(null);
  const [preview, setPreview] = useState<{ url: string; mimeType: string; text: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    openExternalLink(token)
      .then(async (d) => {
        if (cancelled) return;
        setDoc(d);
        try {
          const p = await fetchExternalLinkPreview(token);
          if (cancelled) {
            URL.revokeObjectURL(p.url);
            return;
          }
          objectUrl = p.url;
          setPreview(p);
        } catch {
          /* preview is best-effort — a non-previewable file just offers download */
        }
      })
      .catch((err) => setError(err instanceof ExternalLinkError ? err.code : "link_unavailable"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token]);

  const previewKind = isPreviewable(preview?.mimeType);

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-6 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-tint text-primary">
          <LockIcon size={18} />
        </span>
        <div>
          <p className="text-[14.5px] font-semibold text-ink">Shared document</p>
          <p className="text-[12.5px] text-subtle">Secure link · access is logged</p>
        </div>
        {doc && preview && doc.permission === "download" && (
          <button
            type="button"
            disabled={downloading}
            onClick={() => {
              setDownloading(true);
              void downloadExternalLinkFile(token, doc.documentRef).finally(() => setDownloading(false));
            }}
            className={`${primaryButtonBase} ml-auto flex items-center gap-2 px-4 py-2`}
          >
            <DownloadIcon size={15} /> Download
          </button>
        )}
      </header>

      <main className="flex flex-1 flex-col items-center px-4 py-8">
        {loading ? (
          <p className="mt-24 text-[14.5px] text-muted">Opening…</p>
        ) : error ? (
          <div className="mt-24 max-w-md text-center">
            <h1 className="text-[22px] font-bold tracking-[-0.4px] text-ink">Link unavailable</h1>
            <p className="mt-3 text-[15px] text-muted">{ERROR_COPY[error] ?? ERROR_COPY.link_unavailable}</p>
          </div>
        ) : doc ? (
          <div className="w-full max-w-4xl">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="plate px-2.5 py-1 text-[13px]">{doc.documentRef}</span>
              <span className="text-[16px] font-semibold text-ink">{doc.title ?? "Untitled"}</span>
            </div>
            {(previewKind === "markdown" || previewKind === "text") && preview ? (
              <div className="max-h-[80vh] overflow-auto rounded-xl border border-line bg-surface px-8 py-7 shadow-card">
                {previewKind === "markdown" ? (
                  <LazyMarkdownView source={preview.text ?? ""} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13.5px] leading-relaxed text-ink">{preview.text}</pre>
                )}
              </div>
            ) : previewKind === "image" && preview ? (
              <img src={preview.url} alt={doc.title ?? "Document"} className="mx-auto max-h-[78vh] rounded-xl border border-line bg-surface shadow-card" />
            ) : previewKind === "pdf" && preview ? (
              // A view-only link hides the browser PDF viewer's own toolbar, which would otherwise
              // offer one-click download/print. A deterrent, not a guarantee: previewed bytes are
              // on the client.
              <iframe
                title="Document"
                src={doc.permission === "download" ? preview.url : `${preview.url}#toolbar=0&navpanes=0`}
                className="h-[80vh] w-full rounded-xl border border-line bg-surface"
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-16 text-center">
                <p className="text-[15px] font-semibold text-ink">No inline preview for this file type</p>
                <p className="mt-1.5 text-[13.5px] text-subtle">
                  {doc.permission === "download" ? "Use Download above to open it." : "This link is view-only."}
                </p>
              </div>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
