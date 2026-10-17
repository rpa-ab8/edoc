/**
 * The accepted upload formats (Feature Spec §6.4 / UPL): PDF, JPEG, PNG, DOCX, XLSX. Anything else
 * is rejected with a clear message rather than failing silently.
 *
 * A file is accepted when either its declared MIME type or its filename extension maps to one of
 * these — browsers and OSes are inconsistent about the MIME they attach (Office files often arrive
 * as `application/octet-stream`), so the extension is a legitimate fallback. The canonical MIME is
 * what gets stored on the version, so downstream (the viewer, the OCR worker) sees one value per
 * format regardless of what the client sent.
 */
export interface AcceptedFormat {
  mimeType: string;
  extensions: string[];
  /** Whether the OCR worker attempts text extraction on this format. */
  ocr: "image" | "pdf" | "none";
}

export const ACCEPTED_FORMATS: AcceptedFormat[] = [
  { mimeType: "application/pdf", extensions: ["pdf"], ocr: "pdf" },
  { mimeType: "image/jpeg", extensions: ["jpg", "jpeg"], ocr: "image" },
  { mimeType: "image/png", extensions: ["png"], ocr: "image" },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
    ocr: "none",
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
    ocr: "none",
  },
];

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolves the accepted format for a declared MIME + filename, or null if unsupported. Prefers a
 * MIME match, then falls back to the extension.
 */
export function resolveFormat(declaredMime: string | undefined, fileName: string): AcceptedFormat | null {
  const mime = (declaredMime ?? "").toLowerCase();
  const byMime = ACCEPTED_FORMATS.find((f) => f.mimeType === mime);
  if (byMime) return byMime;

  const ext = extensionOf(fileName);
  return ACCEPTED_FORMATS.find((f) => f.extensions.includes(ext)) ?? null;
}

export const ACCEPTED_EXTENSIONS = ACCEPTED_FORMATS.flatMap((f) => f.extensions);
