/**
 * Upload content & concurrency — `npm run check:upload-content` (backend workspace).
 *
 * SECURITY_AUDIT.md M-5.
 *  1. A file was accepted if its declared MIME *or* its extension matched — the bytes were never
 *     looked at. An HTML page or an executable renamed `.pdf` was stored, and later served inline
 *     as `application/pdf`. Now the content decides: it must be a real PDF / PNG / JPEG / DOCX /
 *     XLSX and agree with what it claims (JPEG ↔ PNG tolerated, stored as what it really is).
 *  2. Each upload is held in memory whole (up to 120 MB) with no concurrency limit. Now a slot is
 *     taken per upload (per process and per user) before the body is read; over the limit → 429.
 *
 * Through the real HTTP stack. The concurrency case holds an upload open by streaming its body
 * slowly, so the second upload genuinely finds the slot taken. DEV ONLY (NAS storage in a temp dir).
 */
import { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import { docxBytes, jpegBytes, markdownBytes, pdfBytes, plainZipBytes, pngBytes, textBytes, xlsxBytes } from "./_fixture-files.js";
import { Redis } from "ioredis";
import dotenv from "dotenv";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/jwt.js";
import { encryptJson } from "../src/lib/crypto.js";
import { permissionMapFrom } from "../src/lib/permissions.js";

const prisma = new PrismaClient();
const env = { ...loadEnv(), MAX_CONCURRENT_UPLOADS: 8, MAX_CONCURRENT_UPLOADS_PER_USER: 1 };
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) pass++;
  else fail++;
}

const stamp = Date.now();
const PREFIX = "zz-upc-";
const storageDir = mkdtempSync(path.join(tmpdir(), "dms-upc-"));
/** Files under the storage dir (recursively) — proves a refused upload stored nothing. */
function storedCount(dir = storageDir): number {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    n += statSync(p).isDirectory() ? storedCount(p) : 1;
  }
  return n;
}

const user = await prisma.user.create({
  data: { email: `${PREFIX}u-${stamp}@example.test`, passwordHash: "x", fullName: "Uploader", emailVerifiedAt: new Date() },
});
const org = await prisma.organization.create({
  data: { name: `ZZ UploadContent ${stamp}`, industry: "test", createdByUserId: user.id, subfolderDepthLimit: 5 },
});
let app: ReturnType<typeof buildApp> | undefined;
try {
  await prisma.storageConfig.create({
    data: { organizationId: org.id, backendType: "nas", status: "verified", credentials: { enc: encryptJson(env, { backendType: "nas", mountPath: storageDir }) } },
  });
  const dept = await prisma.department.create({ data: { organizationId: org.id, name: "Ops", idPrefix: "OPS", subfolderDepthLimit: 5 } });
  const docType = await prisma.documentType.create({
    data: { departmentId: dept.id, name: "File", idCode: "FIL", fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, isRequired: false, sortOrder: 0 }] } },
  });
  const role = await prisma.role.create({
    data: {
      organizationId: org.id,
      departmentId: dept.id,
      name: "Uploader",
      permissions: permissionMapFrom(["documents.view", "documents.preview", "documents.upload", "documents.upload_version", "search.search"]) as object,
    },
  });
  await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId: dept.id, roleId: role.id, status: "active" } });
  const folder = await prisma.folder.create({ data: { organizationId: org.id, departmentId: dept.id, name: "In", depth: 0 } });
  // isSuperAdmin is re-derived from the DB (M-2); this user created the org, but the upload goes
  // through their department role like anyone's.
  const auth = { authorization: `Bearer ${signAccessToken(env, { sub: user.id, emailVerified: true, organizationId: org.id, isSuperAdmin: false })}` };

  app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const server = app;

  const boundary = `----dmsupc${stamp}`;
  function body(fileName: string, mime: string, content: Buffer, fields: Record<string, string> = { documentTypeId: docType.id, onDuplicate: "keep_both" }) {
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(parts);
  }
  const headers = { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` };
  const url = `/departments/${dept.id}/folders/${folder.id}/documents/upload`;
  const upload = (fileName: string, mime: string, content: Buffer) => server.inject({ method: "POST", url, headers, payload: body(fileName, mime, content) });
  const json = (res: { body: string }) => JSON.parse(res.body) as { error?: string; document?: { id: string; versions?: { mimeType: string }[] } };
  const storedMime = async (documentId: string) =>
    (await prisma.version.findFirst({ where: { documentId }, orderBy: { versionNumber: "desc" } }))?.mimeType;

  console.log("\n── genuine files are accepted, stored as what they are ──");
  let firstDocId = "";
  for (const [name, mime, bytes, expect] of [
    ["report.pdf", "application/pdf", pdfBytes(`a${stamp}`), "application/pdf"],
    ["photo.png", "image/png", pngBytes(`b${stamp}`), "image/png"],
    ["photo.jpg", "image/jpeg", jpegBytes(`c${stamp}`), "image/jpeg"],
    ["letter.docx", "application/octet-stream", docxBytes(`d${stamp}`), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/octet-stream", xlsxBytes(`e${stamp}`), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["mislabelled.png", "image/png", jpegBytes(`f${stamp}`), "image/jpeg"],
  ] as const) {
    const res = await upload(name, mime, bytes);
    const id = json(res).document?.id ?? "";
    if (!firstDocId) firstDocId = id;
    check(`control: ${name} is accepted and stored as ${expect.split("/")[1].slice(0, 24)}`, res.statusCode === 201 && (await storedMime(id)) === expect, `${res.statusCode} ${res.body.slice(0, 120)} → ${await storedMime(id)}`);
  }

  console.log("\n── disguised or fake files are refused, and nothing is stored ──");
  for (const [label, name, mime, bytes, code] of [
    ["an HTML page named .pdf", "invoice.pdf", "application/pdf", Buffer.from("<html><script>alert(document.cookie)</script></html>"), "unrecognised_content"],
    ["an executable named .pdf", "invoice.pdf", "application/pdf", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200)]), "unrecognised_content"],
    ["an SVG named .png", "logo.png", "image/png", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`), "unrecognised_content"],
    ["a plain text file named .docx", "notes.docx", "application/octet-stream", Buffer.from("hello world"), "unrecognised_content"],
    ["a generic ZIP named .docx", "archive.docx", "application/octet-stream", plainZipBytes(`g${stamp}`), "unrecognised_content"],
    ["a PNG named .pdf", "scan.pdf", "application/pdf", pngBytes(`h${stamp}`), "content_mismatch"],
    ["a PDF named .docx", "contract.docx", "application/octet-stream", pdfBytes(`i${stamp}`), "content_mismatch"],
    ["an XLSX named .docx", "budget.docx", "application/octet-stream", xlsxBytes(`j${stamp}`), "content_mismatch"],
  ] as const) {
    const before = storedCount();
    const docsBefore = await prisma.document.count({ where: { organizationId: org.id } });
    const res = await upload(name, mime, bytes);
    const after = storedCount();
    const docsAfter = await prisma.document.count({ where: { organizationId: org.id } });
    check(`refused: ${label}`, res.statusCode === 400 && json(res).error === code, `${res.statusCode} ${res.body.slice(0, 140)}`);
    check(`…nothing stored for ${label.split(" named")[0]}`, after === before && docsAfter === docsBefore, `${before}→${after} files, ${docsBefore}→${docsAfter} docs`);
  }

  console.log("\n── Markdown and plain text (added 2026-11-07) ──");
  {
    const marker = `zzmarker${stamp}`;
    const cases = [
      ["notes.md", "text/markdown", markdownBytes(marker), "text/markdown", "a .md file"],
      ["notes2.md", "text/plain", markdownBytes(`${marker}b`), "text/markdown", "a .md sent as text/plain (the extension decides)"],
      ["notes3.markdown", "application/octet-stream", markdownBytes(`${marker}c`), "text/markdown", "a .markdown sent as octet-stream"],
      ["minutes.txt", "text/plain", textBytes(`${marker}d`), "text/plain", "a .txt file"],
    ] as const;
    let mdId = "";
    for (const [name, mime, bytes, expect, label] of cases) {
      const res = await upload(name, mime, bytes);
      const id = json(res).document?.id ?? "";
      if (!mdId) mdId = id;
      const v = await prisma.version.findFirst({ where: { documentId: id } });
      check(`control: ${label} is accepted and stored as ${expect}`, res.statusCode === 201 && v?.mimeType === expect, `${res.statusCode} ${res.body.slice(0, 120)} → ${v?.mimeType}`);
      check(`…its text is stored at upload (no OCR worker needed)`, v?.ocrStatus === "done" && (v?.ocrText ?? "").includes(marker), `${v?.ocrStatus} ${String(v?.ocrText).slice(0, 60)}`);
    }

    const search = await server.inject({ method: "POST", url: `/departments/${dept.id}/search`, headers: auth, payload: { q: marker } });
    const hits = search.statusCode === 200 ? (JSON.parse(search.body) as { results: { id: string }[] }).results : [];
    check("…and is immediately found by full-text search", hits.some((r) => r.id === mdId), `${search.statusCode} ${hits.length} hits`);

    const served = await server.inject({ method: "GET", url: `/documents/${mdId}/file`, headers: auth });
    check(
      "…served as text/markdown; charset=utf-8 with nosniff",
      served.statusCode === 200 &&
        served.headers["content-type"] === "text/markdown; charset=utf-8" &&
        served.headers["x-content-type-options"] === "nosniff" &&
        served.body.includes("# Project notes"),
      `${served.statusCode} ${served.headers["content-type"]} ${served.headers["x-content-type-options"]}`,
    );

    const mentionsPdf = await upload("about-pdfs.md", "text/markdown", Buffer.from(`Our files start with %PDF-1.7 headers ${marker}e\n`));
    check("control: a note that merely mentions %PDF- is still Markdown", mentionsPdf.statusCode === 201, `${mentionsPdf.statusCode} ${mentionsPdf.body.slice(0, 120)}`);
    const inlineHtml = await upload("with-html.md", "text/markdown", Buffer.from(`# Title ${marker}f\n\nSome <b>inline</b> html and <script>x()</script> inside.\n`));
    check(
      "control: Markdown containing inline HTML is accepted (the viewer never renders raw HTML)",
      inlineHtml.statusCode === 201,
      `${inlineHtml.statusCode} ${inlineHtml.body.slice(0, 120)}`,
    );

    for (const [label, name, mime, bytes, code] of [
      ["an HTML page named .md", "page.md", "text/markdown", Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>"), "unrecognised_content"],
      ["an HTML page named .txt", "page.txt", "text/plain", Buffer.from("  <html><body onload=alert(1)></body></html>"), "unrecognised_content"],
      ["an SVG named .txt", "logo.txt", "text/plain", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`), "unrecognised_content"],
      ["invalid UTF-8 named .txt", "bad.txt", "text/plain", Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x00, 0x41]), "unrecognised_content"],
      ["binary control bytes named .md", "bin.md", "text/markdown", Buffer.from("abc\u0000\u0001def"), "unrecognised_content"],
      ["a PNG named .md", "image.md", "text/markdown", pngBytes(`k${stamp}`), "content_mismatch"],
      ["a real PDF named .txt", "doc.txt", "text/plain", pdfBytes(`l${stamp}`), "content_mismatch"],
      ["a DOCX named .md", "doc.md", "text/markdown", docxBytes(`m${stamp}`), "content_mismatch"],
    ] as const) {
      const before = storedCount();
      const res = await upload(name, mime, bytes);
      check(`refused: ${label}`, res.statusCode === 400 && json(res).error === code, `${res.statusCode} ${res.body.slice(0, 140)}`);
      check(`…nothing stored for ${label.split(" named")[0]}`, storedCount() === before);
    }
  }

  console.log("\n── the new-version path checks content too ──");
  {
    const res = await server.inject({
      method: "POST",
      url: `/documents/${firstDocId}/versions/upload`,
      headers,
      payload: body("v2.pdf", "application/pdf", Buffer.from("<html>not a pdf</html>"), {}),
    });
    check("a fake new version is refused", res.statusCode === 400 && json(res).error === "unrecognised_content", `${res.statusCode} ${res.body.slice(0, 120)}`);
    const ok = await server.inject({ method: "POST", url: `/documents/${firstDocId}/versions/upload`, headers, payload: body("v2.pdf", "application/pdf", pdfBytes(`k${stamp}`), {}) });
    check("control: a genuine new version is accepted", ok.statusCode === 201, `${ok.statusCode} ${ok.body.slice(0, 120)}`);
  }

  console.log("\n── concurrent uploads are capped (per user: 1 in this test) ──");
  {
    // Upload #1: stream the body slowly so it holds its slot.
    const slow = new PassThrough();
    const full = body("slow.pdf", "application/pdf", pdfBytes(`slow${stamp}`));
    const first = server.inject({ method: "POST", url, headers: { ...headers, "content-length": String(full.length) }, payload: slow });
    slow.write(full.subarray(0, 40));
    await new Promise((r) => setTimeout(r, 300)); // let #1 reach its handler and take the slot

    const second = await upload("second.pdf", "application/pdf", pdfBytes(`second${stamp}`));
    check("a second upload while the first is in flight is refused with 429", second.statusCode === 429 && json(second).error === "upload_busy", `${second.statusCode} ${second.body.slice(0, 120)}`);
    check("…with a Retry-After header", second.headers["retry-after"] !== undefined, JSON.stringify(second.headers).slice(0, 120));

    slow.end(full.subarray(40));
    const firstRes = await first;
    check("control: the first upload completes normally", firstRes.statusCode === 201, `${firstRes.statusCode} ${firstRes.body.slice(0, 120)}`);
    const third = await upload("third.pdf", "application/pdf", pdfBytes(`third${stamp}`));
    check("control: the slot is released — the next upload succeeds", third.statusCode === 201, `${third.statusCode} ${third.body.slice(0, 120)}`);
    const bad = await upload("bad.pdf", "application/pdf", Buffer.from("nope"));
    const afterBad = await upload("fourth.pdf", "application/pdf", pdfBytes(`fourth${stamp}`));
    check("control: a refused upload also releases its slot", bad.statusCode === 400 && afterBad.statusCode === 201, `${bad.statusCode} / ${afterBad.statusCode}`);
  }
} catch (err) {
  check("unexpected error", false, String((err as Error).stack ?? err));
} finally {
  await app?.close();
  await purgeTestAuditEvents(prisma, { where: { organizationId: org.id } });
  await prisma.fieldValue.deleteMany({ where: { document: { organizationId: org.id } } });
  await prisma.document.updateMany({ where: { organizationId: org.id }, data: { currentVersionId: null } });
  await prisma.version.deleteMany({ where: { organizationId: org.id } });
  await prisma.document.deleteMany({ where: { organizationId: org.id } });
  await prisma.documentRefSequence.deleteMany({ where: { organizationId: org.id } });
  await prisma.folder.deleteMany({ where: { organizationId: org.id } });
  await prisma.membership.deleteMany({ where: { organizationId: org.id } });
  await prisma.fieldDef.deleteMany({ where: { documentType: { department: { organizationId: org.id } } } });
  await prisma.documentType.deleteMany({ where: { department: { organizationId: org.id } } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.storageConfig.deleteMany({ where: { organizationId: org.id } });
  await prisma.department.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  rmSync(storageDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
