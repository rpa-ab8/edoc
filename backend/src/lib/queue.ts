import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Env } from "../config/env.js";

/**
 * The OCR job queue (BullMQ over Redis — Tech Stack §3.6). The API enqueues one job per uploaded
 * file version; the worker (`src/worker/ocr.worker.ts`, run as a separate process) extracts text
 * and writes it back to the version. Enqueue failures never fail an upload — OCR degrades to
 * metadata-only search (UPL-6), so callers treat `enqueueOcr` as best-effort.
 */
export const OCR_QUEUE_NAME = "ocr";

export interface OcrJobData {
  versionId: string;
}

// BullMQ requires `maxRetriesPerRequest: null` on its Redis connection (blocking commands).
export function createQueueConnection(env: Env): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let queue: Queue<OcrJobData> | null = null;

export function getOcrQueue(env: Env): Queue<OcrJobData> {
  if (!queue) {
    queue = new Queue<OcrJobData>(OCR_QUEUE_NAME, { connection: createQueueConnection(env) });
  }
  return queue;
}

/**
 * Best-effort enqueue: a Redis outage or queue error is logged and swallowed, leaving the version
 * at `ocrStatus = pending`. The document is fully usable and searchable by metadata regardless.
 */
export async function enqueueOcr(env: Env, versionId: string): Promise<void> {
  try {
    await getOcrQueue(env).add(
      "extract",
      { versionId },
      { attempts: 2, backoff: { type: "fixed", delay: 5000 }, removeOnComplete: 200, removeOnFail: 500 },
    );
  } catch (err) {
    console.warn(`[ocr] failed to enqueue version ${versionId} — OCR will not run for it:`, err);
  }
}
