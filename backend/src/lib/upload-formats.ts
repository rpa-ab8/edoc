/**
 * The accepted upload formats (Feature Spec §6.4 / UPL).
 *
 * Core formats — PDF, JPEG, PNG, DOCX, XLSX, Markdown (.md/.markdown) and plain text (.txt) — are
 * verified by content (SECURITY_AUDIT.md M-5) and previewed in the viewer.
 *
 * Since 2026-11-27 (product owner), any other file is accepted too, so IT departments can file
 * `.env`, `.key`, `.json`, `.yml`, `.log`, `.tmp`, `.zip`, certificates and the like:
 *   - clean UTF-8 text → stored as `text/plain`: previewed as text, searchable;
 *   - anything else    → stored as `application/octet-stream`: download only, never served inline,
 *     no text extracted.
 * Two things stay refused: programs and scripts Windows runs on a double-click (`.exe`, `.bat`,
 * `.msi`, `.js`…) or whose bytes are an executable whatever the name, and web pages / SVG (a browser
 * would run them). Secret files (`.env*`, `.key`, `.pem`, `id_rsa`…) are stored and previewable but
 * their contents are never indexed for search (`isSecretFile`).
 *
 * Text formats carry their own content as their searchable text, so they need no OCR: the upload
 * stores it on the version straight away (`ocr: "text"`).
 *
 * A core file is accepted when either its declared MIME type or its filename extension maps to one of
 * them — browsers and OSes are inconsistent about the MIME they attach (Office files often arrive
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

/** Any other clean-text file (`.env`, `.json`, `.log`, `.yml`, a file with no extension…). */
export const OTHER_TEXT_FORMAT: AcceptedFormat = { mimeType: "text/plain", extensions: [], ocr: "text" };
/** Any other non-text file (`.tmp`, `.zip`, `.pfx`…): stored as-is, download only. */
export const OTHER_BINARY_FORMAT: AcceptedFormat = { mimeType: "application/octet-stream", extensions: [], ocr: "none" };

/**
 * Extensions that are never accepted: programs and scripts Windows runs (or installs) on a
 * double-click, shortcuts, and pages/images a browser would execute. Matched on the last extension,
 * so `invoice.pdf.exe` is refused too. Kept equal to the frontend's BLOCKED_UPLOAD_EXTENSIONS.
 */
export const BLOCKED_EXTENSIONS = [
  // programs, installers, libraries
  "exe", "dll", "com", "scr", "pif", "cpl", "msi", "msp", "mst", "msc", "sys", "drv", "ocx",
  "appx", "msix", "application", "gadget", "jar",
  // scripts Windows runs on a double-click
  "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ws", "hta", "reg", "inf", "scf",
  // shortcuts
  "lnk", "url",
  // pages and images a browser executes
  "html", "htm", "xhtml", "xht", "shtml", "mht", "mhtml", "svg", "svgz",
];

/** Executable file signatures, refused whatever the file is called. */
function isExecutable(data: Buffer): boolean {
  if (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a) return true; // Windows PE ("MZ")
  if (data.length < 4) return false;
  const sig = data.readUInt32BE(0);
  return (
    sig === 0x7f454c46 || // ELF
    sig === 0xfeedface || sig === 0xfeedfacf || sig === 0xcefaedfe || sig === 0xcffaedfe || // Mach-O
    sig === 0xcafebabe // Mach-O universal / Java class
  );
}

const SECRET_EXTENSIONS = ["env", "key", "pem", "ppk", "p12", "pfx", "jks", "keystore", "kdbx", "asc", "gpg", "pgp", "ovpn"];
const SECRET_NAMES = [
  /^\.env(\..+)?$/, // .env, .env.production, .env.local…
  /^id_(rsa|dsa|ecdsa|ed25519)$/, // SSH private keys (the .pub halves are public)
  /^\.(npmrc|pgpass|netrc|htpasswd|git-credentials)$/,
  /^(credentials|kubeconfig)$/,
];

/**
 * Whether a file normally holds passwords or private keys. Such files are stored and can be
 * previewed by people allowed to see them, but their text is never put in the search index — a
 * password must not turn up when someone searches for it.
 */
export function isSecretFile(fileName: string): boolean {
  const name = (fileName.split(/[\\/]/).pop() ?? "").toLowerCase();
  return SECRET_EXTENSIONS.includes(extensionOf(name)) || SECRET_NAMES.some((re) => re.test(name));
}

/** Whether a stored MIME type may be served inline (opened in the browser) rather than only downloaded. */
export function isInlineSafe(mimeType: string): boolean {
  return ["application/pdf", "image/png", "image/jpeg", "text/plain", "text/markdown"].includes(mimeType.toLowerCase());
}

/** Never index a secret file's text: it keeps its MIME (so it can still be previewed) but carries no text. */
function withoutTextIfSecret(format: AcceptedFormat, fileName: string): AcceptedFormat {
  return format.ocr === "text" && isSecretFile(fileName) ? { ...format, ocr: "none" } : format;
}

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
 *
 * A file whose extension is none of the core formats is an "other" file: clean text is stored as
 * `text/plain`, anything else as download-only `application/octet-stream`. Blocked extensions and
 * executable bytes are refused first, whatever the file claims to be.
 */
export function verifyUploadFormat(declaredMime: string | undefined, fileName: string, data: Buffer): UploadFormatVerdict {
  const ext = extensionOf(fileName);
  if (BLOCKED_EXTENSIONS.includes(ext) || isExecutable(data)) return { ok: false, code: "unsupported_format" };

  // A core claim needs a core extension — or no extension and a core declared MIME. An unknown
  // extension never borrows a core format from the declared MIME.
  const claimed = ACCEPTED_EXTENSIONS.includes(ext) || ext === "" ? resolveFormat(declaredMime, fileName) : null;
  if (!claimed) {
    // A recognised binary format under another name (a PDF renamed .tmp) is kept as a file, not shown as text.
    const format = !detectFormat(data) && isPlainText(data) ? OTHER_TEXT_FORMAT : OTHER_BINARY_FORMAT;
    return { ok: true, format: withoutTextIfSecret(format, fileName) };
  }
  const detected = detectFormat(data);

  // Text has no signature to detect, so the evidence is the reverse: the bytes must be clean text, and
  // must not be one of the binary formats above wearing a text extension.
  if (claimed.ocr === "text") {
    // PDF detection tolerates leading junk; a note that merely *mentions* "%PDF-" near the top isn't a PDF.
    const realBinary = detected && (detected.mimeType !== "application/pdf" || data.subarray(0, 5).toString("latin1") === "%PDF-");
    if (realBinary) return { ok: false, code: "content_mismatch", claimed, detected };
    return isPlainText(data)
      ? { ok: true, format: withoutTextIfSecret(claimed, fileName) }
      : { ok: false, code: "unrecognised_content", claimed };
  }
  if (!detected) return { ok: false, code: "unrecognised_content", claimed };
  const bothImages = claimed.ocr === "image" && detected.ocr === "image";
  if (claimed.mimeType !== detected.mimeType && !bothImages) {
    return { ok: false, code: "content_mismatch", claimed, detected };
  }
  return { ok: true, format: detected };
}
