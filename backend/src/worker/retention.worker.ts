/**
 * Retention worker — a separate process from the API and the OCR worker (`npm run worker:retention`
 * in the backend workspace). PRD v1.2 RET-3.
 *
 * On start it registers one BullMQ job scheduler that fires daily at RETENTION_JOB_TIME (default
 * 02:00) in RETENTION_JOB_TIME_ZONE (default Asia/Kolkata), then processes those jobs: auto-delete
 * moves expired documents to trash, then the automatic trash purge permanently removes trash items
 * older than the trash window. Legal Holds stop both.
 *
 * `--once` runs the same work immediately and exits — for an operator, or to check a configuration —
 * without touching Redis. Both paths are idempotent: running twice on one day changes nothing the
 * second time.
 *
 * Concurrency is 1 and the job is not retried automatically: per-document failures are already
 * isolated and logged inside the run, and a whole-run failure is better looked at than repeated.
 */
import { Queue, Worker } from "bullmq";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { RETENTION_QUEUE_NAME, RETENTION_SCHEDULER_ID, createQueueConnection, dailyCronPattern } from "../lib/queue.js";
import { runDailyRetention } from "../modules/retention/retention.service.js";

const env = loadEnv();
const deps = { prisma, env };

async function runAndLog(trigger: string) {
  const started = Date.now();
  console.log(`[retention] run started (${trigger})`);
  const { autoDelete, trashPurge } = await runDailyRetention(deps);
  console.log(
    `[retention] run finished in ${Date.now() - started}ms — auto-delete: ${autoDelete.moved} moved to trash, ` +
      `${autoDelete.skippedHeld} held, ${autoDelete.alreadyInTrash} already in trash, ${autoDelete.failed.length} failed ` +
      `across ${autoDelete.departments} department(s); trash purge: ${trashPurge.purged} removed, ` +
      `${trashPurge.skippedHeld} held, ${trashPurge.failed.length} failed`,
  );
  return { autoDelete, trashPurge };
}

if (process.argv.includes("--once")) {
  try {
    await runAndLog("manual --once");
  } finally {
    await prisma.$disconnect();
  }
  process.exit(0);
}

const queue = new Queue(RETENTION_QUEUE_NAME, { connection: createQueueConnection(env) });
const pattern = dailyCronPattern(env.RETENTION_JOB_TIME);
await queue.upsertJobScheduler(
  RETENTION_SCHEDULER_ID,
  { pattern, tz: env.RETENTION_JOB_TIME_ZONE },
  { name: "daily-run", opts: { removeOnComplete: 60, removeOnFail: 120 } },
);
console.log(`[retention] scheduled daily at ${env.RETENTION_JOB_TIME} ${env.RETENTION_JOB_TIME_ZONE} (cron "${pattern}")`);

const worker = new Worker(RETENTION_QUEUE_NAME, async () => runAndLog("schedule"), {
  connection: createQueueConnection(env),
  concurrency: 1,
});

worker.on("ready", () => console.log("[retention] worker ready"));
worker.on("failed", (job, err) => console.error(`[retention] run ${job?.id} failed:`, err?.message));

async function shutdown() {
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
