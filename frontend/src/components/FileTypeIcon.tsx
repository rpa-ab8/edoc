import {
  DocumentIcon,
  DownloadIcon,
  FileImageIcon,
  FilePdfIcon,
  FileSheetIcon,
  LockIcon,
} from "./icons";

type IconComponent = typeof DocumentIcon;

/** Files that usually hold passwords or keys — mirrors the server's `isSecretFile` (upload-formats.ts). */
function isSecretName(fileName: string): boolean {
  const name = (fileName.split(/[\\/]/).pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return (
    ["env", "key", "pem", "ppk", "p12", "pfx", "jks", "keystore", "kdbx", "asc", "gpg", "pgp", "ovpn"].includes(ext) ||
    /^\.env(\..+)?$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)
  );
}

/**
 * Maps a file's MIME type (or, as a fallback, its extension) to a distinct icon + colour, so a
 * documents list is scannable by type at a glance: PDFs read red, images teal, spreadsheets green,
 * Word documents indigo, Markdown orange, anything else (plain text included) a neutral document. Colours use the categorical tints, which
 * carry no state meaning (Tailwind config note).
 */
function resolve(mimeType?: string | null, fileName?: string | null): { Icon: IconComponent; tint: string } {
  const mime = (mimeType ?? "").toLowerCase();
  const dot = (fileName ?? "").lastIndexOf(".");
  const ext = dot >= 0 ? (fileName ?? "").slice(dot + 1).toLowerCase() : "";

  if (mime === "application/pdf" || ext === "pdf") {
    return { Icon: FilePdfIcon, tint: "bg-danger-tint text-danger" };
  }
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
    return { Icon: FileImageIcon, tint: "bg-cat-teal-tint text-cat-teal" };
  }
  if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || ["xlsx", "xls", "csv"].includes(ext)) {
    return { Icon: FileSheetIcon, tint: "bg-cat-green-tint text-cat-green" };
  }
  if (mime.includes("wordprocessingml") || mime.includes("msword") || ["docx", "doc"].includes(ext)) {
    return { Icon: DocumentIcon, tint: "bg-cat-indigo-tint text-cat-indigo" };
  }
  if (mime === "text/markdown" || ["md", "markdown"].includes(ext)) {
    return { Icon: DocumentIcon, tint: "bg-cat-orange-tint text-cat-orange" };
  }
  // IT files (2026-11-27): secrets read as a lock, download-only files as a download glyph.
  if (isSecretName(fileName ?? "")) {
    return { Icon: LockIcon, tint: "bg-surface-muted text-muted" };
  }
  if (mime === "application/octet-stream") {
    return { Icon: DownloadIcon, tint: "bg-surface-muted text-subtle" };
  }
  return { Icon: DocumentIcon, tint: "bg-surface-muted text-subtle" };
}

/** A rounded icon-bubble whose glyph and colour reflect the document's file type. */
export function FileTypeIcon({
  mimeType,
  fileName,
  className = "h-9 w-9",
  iconSize = 17,
}: {
  mimeType?: string | null;
  fileName?: string | null;
  className?: string;
  iconSize?: number;
}) {
  const { Icon, tint } = resolve(mimeType, fileName);
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${tint} ${className}`}>
      <Icon size={iconSize} />
    </span>
  );
}
