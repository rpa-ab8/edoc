/**
 * OCR worker — a separate process from the API (`npm run worker` in the backend workspace).
 *
 * Pulls jobs off the BullMQ `ocr` queue, reads each version's file through the storage abstraction,
 * extracts text (Tesseract for images, embedded-text extraction for PDFs, nothing for Office
 * files), and writes `ocrText`/`ocrStatus` back. Any failure is caught and recorded as
 * `ocrStatus = failed` — the document stays fully searchable by metadata, so OCR degrades rather
 * than blocks (UPL-6). Failures are deliberately *not* re-thrown: OCR failure is a terminal degraded
 * state, not a retryable infrastructure error, so we don't re-run heavy work.
 */
import { Worker } from "bullmq";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { OCR_QUEUE_NAME, createQueueConnection, type OcrJobData } from "../lib/queue.js";
import { getActiveStorageDriver } from "../modules/storage/storage.service.js";
import { extractPlainText, resolveFormat } from "../lib/upload-formats.js";
import { refreshDocumentSearchVector } from "../lib/search-vector.js";

const env = loadEnv();

// Cap the stored text so a pathological document can't bloat a row; tsvector search doesn't need
// the whole of a very long document to be useful.
const MAX_OCR_TEXT_CHARS = 1_000_000;

async function extractImageText(buffer: Buffer): Promise<string> {
  // tesseract.js ships as CommonJS, so a dynamic `import()` hands back the module *namespace* and
  // the real API sits on `.default` — reading `recognize` off the namespace yields undefined and
  // every image job dies with "Tesseract.recognize is not a function". Found by Module 13's
  // performance run (2026-07-25): because the worker records any failure as `ocrStatus = failed`
  // and degrades to metadata-only search (UPL-6), image OCR had been silently non-functional
  // rather than loudly broken.
  const { default: Tesseract } = await import("tesseract.js");
  const { data } = await Tesseract.recognize(buffer, "eng");
  return data.text ?? "";
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // `first` bounds how many pages are parsed, so an oversized scan is capped rather than allowed
    // to stall the queue (UPL-7). `result.total` still reports the true page count if we ever want it.
    const result = await parser.getText({ first: env.OCR_MAX_PAGES });
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractText(mimeType: string, fileName: string, buffer: Buffer): Promise<string> {
  const format = resolveFormat(mimeType, fileName);
  if (!format || format.ocr === "none") return "";
  // Text files are normally stored with their text at upload and never queued; handled here too so a
  // re-queued or legacy version still ends up searchable.
  if (format.ocr === "text") return extractPlainText(buffer);
  return format.ocr === "image" ? extractImageText(buffer) : extractPdfText(buffer);
}

const worker = new Worker<OcrJobData>(
  OCR_QUEUE_NAME,
  async (job) => {
    const { versionId } = job.data;
    const version = await prisma.version.findUnique({
      where: { id: versionId },
      select: { id: true, organizationId: true, documentId: true, storageRef: true, mimeType: true, fileName: true },
    });
    if (!version) return; // the version was deleted before OCR ran — nothing to do

    try {
      const driver = await getActiveStorageDriver({ prisma, env }, version.organizationId);
      const buffer = await driver.get(version.storageRef);
      const text = (await extractText(version.mimeType, version.fileName, buffer)).slice(0, MAX_OCR_TEXT_CHARS).trim();
      await prisma.version.update({
        where: { id: versionId },
        data: { ocrStatus: "done", ocrText: text.length > 0 ? text : null },
      });
      // The document's OCR body text is now available — fold it into the search index.
      await refreshDocumentSearchVector(prisma, version.documentId);
    } catch (err) {
      console.error(`[ocr] extraction failed for version ${versionId}:`, err);
      await prisma.version
        .update({ where: { id: versionId }, data: { ocrStatus: "failed" } })
        .catch(() => {});
    }
  },
  { connection: createQueueConnection(env), concurrency: 2 },
);

worker.on("ready", () => console.log("[ocr] worker ready, waiting for jobs"));
worker.on("completed", (job) => console.log(`[ocr] processed version ${job.data.versionId}`));
worker.on("failed", (job, err) => console.error(`[ocr] job error for ${job?.data.versionId}:`, err?.message));

async function shutdown() {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
