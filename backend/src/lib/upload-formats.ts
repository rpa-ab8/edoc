/**
 * The accepted upload formats (Feature Spec §6.4 / UPL): PDF, JPEG, PNG, DOCX, XLSX, and — added
 * 2026-11-07 by the product owner — Markdown (.md/.markdown) and plain text (.txt). Anything else is
 * rejected with a clear message rather than failing silently.
 *
 * Text formats carry their own content as their searchable text, so they need no OCR: the upload
 * stores it on the version straight away (`ocr: "text"`).
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
  /** How the format's text is obtained: OCR'd image, PDF text layer, none (Office), or the file
   *  itself (Markdown / plain text — stored at upload, no worker involved). */
  ocr: "image" | "pdf" | "text" | "none";
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
  { mimeType: "text/markdown", extensions: ["md", "markdown"], ocr: "text" },
  { mimeType: "text/plain", extensions: ["txt"], ocr: "text" },
];

/** MIME types clients commonly attach to Markdown that aren't the canonical `text/markdown`. */
const MARKDOWN_MIME_ALIASES = ["text/x-markdown", "text/x-web-markdown"];

/** Longest text stored as a text file's searchable body — the same cap the OCR worker applies. */
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;

/** A UTF-8 byte-order mark at the very start of a text file (built from its code point so no
 *  invisible character sits in this source file). */
const LEADING_BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolves the accepted format for a declared MIME + filename, or null if unsupported. Prefers a
 * MIME match, then falls back to the extension — except within the text family, where the extension
 * decides: browsers and OSes routinely send a `.md` file as `text/plain` (or octet-stream), and the
 * name is the only thing that says it's Markdown.
 */
export function resolveFormat(declaredMime: string | undefined, fileName: string): AcceptedFormat | null {
  const mime = (declaredMime ?? "").toLowerCase();
  const ext = extensionOf(fileName);
  const byExt = ACCEPTED_FORMATS.find((f) => f.extensions.includes(ext));
  const byMime = ACCEPTED_FORMATS.find((f) => f.mimeType === mime) ??
    (MARKDOWN_MIME_ALIASES.includes(mime) ? ACCEPTED_FORMATS.find((f) => f.mimeType === "text/markdown") : undefined);

  if (byMime?.ocr === "text" && byExt?.ocr === "text") return byExt;
  return byMime ?? byExt ?? null;
}

/**
 * Whether bytes are genuinely a plain-text document: valid UTF-8 (a BOM is fine), no NUL bytes, no
 * other control characters beyond tab/newline/carriage-return/form-feed — and not a web page or SVG
 * with a text extension. A text file is served `text/plain`/`text/markdown` with `nosniff` and the
 * viewer never renders raw HTML, so markup *inside* a Markdown document is harmless; refusing files
 * that *are* HTML/SVG/XML stops the format being used to smuggle one in.
 */
export function isPlainText(data: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) return false;
  const head = text.replace(LEADING_BOM, "").trimStart().slice(0, 64).toLowerCase();
  return !["<!doctype", "<html", "<?xml", "<svg", "<script", "<head", "<body"].some((tag) => head.startsWith(tag));
}

/** The `Content-Type` to serve a stored file with: text formats get an explicit UTF-8 charset, so a
 *  browser never guesses the encoding (and garbles non-ASCII text). */
export function contentTypeHeader(mimeType: string): string {
  return mimeType.startsWith("text/") ? `${mimeType}; charset=utf-8` : mimeType;
}

/** A text file's searchable body: the decoded text without a BOM, capped. */
export function extractPlainText(data: Buffer): string {
  return data.toString("utf8").replace(LEADING_BOM, "").slice(0, MAX_EXTRACTED_TEXT_CHARS).trim();
}

export const ACCEPTED_EXTENSIONS = ACCEPTED_FORMATS.flatMap((f) => f.extensions);

const byMime = (mime: string) => ACCEPTED_FORMATS.find((f) => f.mimeType === mime)!;

/**
 * Names of the entries in a ZIP's central directory, or null if `data` isn't a well-formed ZIP.
 * Reads only the directory (no decompression, so no zip-bomb exposure) and caps the entry count.
 */
function zipEntryNames(data: Buffer): string[] | null {
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) return null;
  // End-of-central-directory record: within the last 22 + 65535 (max comment) bytes.
  const floor = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = data.length - 22; i >= floor; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  if (count === 0 || count > 10_000 || offset >= eocd) return null;
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > eocd || data.readUInt32LE(offset) !== 0x02014b50) return null;
    const nameLen = data.readUInt16LE(offset + 28);
    const extraLen = data.readUInt16LE(offset + 30);
    const commentLen = data.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLen;
    if (end > eocd) return null;
    names.push(data.toString("utf8", offset + 46, end));
    offset = end + extraLen + commentLen;
  }
  return names;
}

/**
 * The accepted format a file's *bytes* actually are, or null if they're none of them
 * (SECURITY_AUDIT.md M-5). The declared MIME and the extension are claims; this is the evidence.
 *   PDF  — "%PDF-" within the first 1024 bytes (the PDF spec's allowance for leading junk)
 *   PNG  — the 8-byte PNG signature
 *   JPEG — FF D8 FF
 *   DOCX / XLSX — a ZIP whose directory holds [Content_Types].xml plus word/document.xml or
 *                 xl/workbook.xml respectively
 */
export function detectFormat(data: Buffer): AcceptedFormat | null {
  if (data.subarray(0, 1024).includes("%PDF-")) return byMime("application/pdf");
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return byMime("image/png");
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return byMime("image/jpeg");
  const names = zipEntryNames(data);
  if (names && names.includes("[Content_Types].xml")) {
    if (names.includes("word/document.xml")) {
      return byMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    }
    if (names.includes("xl/workbook.xml")) {
      return byMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
  }
  return null;
}

export type UploadFormatVerdict =
  | { ok: true; format: AcceptedFormat }
  | { ok: false; code: "unsupported_format" | "unrecognised_content" | "content_mismatch"; claimed?: AcceptedFormat; detected?: AcceptedFormat };

/**
 * Accepts an upload only when its *content* is an accepted format and agrees with what it claims to
 * be (declared MIME / extension). The stored MIME is the detected one, so a renamed HTML page or
 * executable can never be filed — or later served inline — as a PDF. The one tolerated mismatch is
 * JPEG ↔ PNG: a mislabelled photo is common and harmless, and is stored as what it really is.
 * Markdown and plain text are verified the other way round (no signature exists): clean UTF-8 text,
 * not an HTML/SVG page, and not a binary format renamed — see `isPlainText`.
 */
export function verifyUploadFormat(declaredMime: string | undefined, fileName: string, data: Buffer): UploadFormatVerdict {
  const claimed = resolveFormat(declaredMime, fileName);
  if (!claimed) return { ok: false, code: "unsupported_format" };
  const detected = detectFormat(data);

  // Text has no signature to detect, so the evidence is the reverse: the bytes must be clean text, and
  // must not be one of the binary formats above wearing a text extension.
  if (claimed.ocr === "text") {
    // PDF detection tolerates leading junk; a note that merely *mentions* "%PDF-" near the top isn't a PDF.
    const realBinary = detected && (detected.mimeType !== "application/pdf" || data.subarray(0, 5).toString("latin1") === "%PDF-");
    if (realBinary) return { ok: false, code: "content_mismatch", claimed, detected };
    return isPlainText(data) ? { ok: true, format: claimed } : { ok: false, code: "unrecognised_content", claimed };
  }
  if (!detected) return { ok: false, code: "unrecognised_content", claimed };
  const bothImages = claimed.ocr === "image" && detected.ocr === "image";
  if (claimed.mimeType !== detected.mimeType && !bothImages) {
    return { ok: false, code: "content_mismatch", claimed, detected };
  }
  return { ok: true, format: detected };
}
