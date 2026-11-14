/**
 * Data-guard worker — `node dist/worker/data-guard.js [--once] [--manifest] [--scrub]`.
 *
 * Postgres is the only map from the opaque R2/NAS object keys (`<org>/<uuid>`) to what each file is,
 * so losing it (and its backups) would leave anonymous blobs. This job writes the map out in a form
 * that survives without the database, and checks the bytes still match what the database recorded:
 *
 *  --manifest  writes /backups/manifest-<stamp>.jsonl.gz — one JSON line per Version with the storage
 *              ref, checksum, file name, document ref/title and folder path. backup.sh encrypts it
 *              (age) and copies it off-site next to the database dump.
 *  --scrub     re-reads a sample of stored objects through the storage driver, re-hashes them and
 *              compares with `Version.checksum`; reports missing or mismatching objects.
 *
 * With no mode flag both run. `--once` runs now and exits (exit code 1 if the scrub found a problem);
 * without it the process runs daily at DATA_GUARD_TIME_UTC (default 01:30, before the 02:00 backup).
 * Each organization is processed separately and every query filters on organization_id.
 *
 * Environment: DATA_GUARD_DIR (default /backups), DATA_GUARD_SCRUB_SAMPLE (default 200 versions per
 * org per run), DATA_GUARD_HEALTHCHECK_URL (dead-man's-switch; "/fail" appended on failure),
 * DATA_GUARD_KEEP_DAYS (manifest retention on disk, default 14).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getActiveStorageDriver } from "../modules/storage/storage.service.js";

const env = loadEnv();
const deps = { prisma, env };
const DIR = process.env.DATA_GUARD_DIR ?? "/backups";
const SAMPLE = Number(process.env.DATA_GUARD_SCRUB_SAMPLE ?? 200);
const KEEP_DAYS = Number(process.env.DATA_GUARD_KEEP_DAYS ?? 14);
const HC = process.env.DATA_GUARD_HEALTHCHECK_URL;

async function ping(suffix = "") {
  if (!HC) return;
  try {
    await fetch(`${HC}${suffix}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    console.warn("[data-guard] healthcheck ping failed (ignored)");
  }
}

async function folderPaths(organizationId: string): Promise<Map<string, string>> {
  const folders = await prisma.folder.findMany({
    where: { organizationId },
    select: { id: true, name: true, parentFolderId: true },
  });
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string>();
  const pathOf = (id: string): string => {
    const hit = cache.get(id);
    if (hit) return hit;
    const f = byId.get(id);
    const p = !f ? "" : f.parentFolderId ? `${pathOf(f.parentFolderId)}/${f.name}` : f.name;
    cache.set(id, p);
    return p;
  };
  for (const f of folders) pathOf(f.id);
  return cache;
}

async function writeManifest(): Promise<string> {
  const lines: string[] = [];
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    const paths = await folderPaths(org.id);
    let cursor: string | undefined;
    for (;;) {
      const versions = await prisma.version.findMany({
        where: { organizationId: org.id },
        orderBy: { id: "asc" },
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true, documentId: true, versionNumber: true, storageRef: true, fileName: true, fileSize: true,
          mimeType: true, checksum: true, createdAt: true,
          document: {
            select: { documentRef: true, titleValue: true, folderId: true, departmentId: true, status: true, uploadedAt: true },
          },
        },
      });
      if (versions.length === 0) break;
      for (const v of versions) {
        lines.push(
          JSON.stringify({
            organizationId: org.id,
            versionId: v.id,
            documentId: v.documentId,
            documentRef: v.document.documentRef,
            title: v.document.titleValue,
            versionNumber: v.versionNumber,
            storageRef: v.storageRef,
            fileName: v.fileName,
            fileSize: v.fileSize,
            mimeType: v.mimeType,
            sha256: v.checksum,
            folderPath: paths.get(v.document.folderId) ?? null,
            departmentId: v.document.departmentId,
            status: v.document.status,
            uploadedAt: v.document.uploadedAt,
            versionCreatedAt: v.createdAt,
          }),
        );
      }
      cursor = versions[versions.length - 1]!.id;
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const file = path.join(DIR, `manifest-${stamp}.jsonl.gz`);
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(`${file}.partial`, gzipSync(Buffer.from(lines.join("\n") + "\n")));
  await fs.rename(`${file}.partial`, file);
  console.log(`[data-guard] manifest: ${lines.length} version(s) → ${file}`);

  // prune old manifests
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of await fs.readdir(DIR)) {
    if (!/^manifest-.*\.jsonl\.gz(\.age)?$/.test(name)) continue;
    const full = path.join(DIR, name);
    if ((await fs.stat(full)).mtimeMs < cutoff) await fs.unlink(full);
  }
  return file;
}

/** Returns the number of problems found (missing objects + checksum mismatches). */
async function scrub(): Promise<number> {
  let problems = 0;
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    let driver;
    try {
      driver = await getActiveStorageDriver(deps, org.id);
    } catch (err) {
      console.warn(`[data-guard] scrub: org ${org.id} has no usable storage driver — skipped (${(err as Error).message})`);
      continue;
    }
    const total = await prisma.version.count({ where: { organizationId: org.id, checksum: { not: null } } });
    const skip = total > SAMPLE ? Math.floor(Math.random() * (total - SAMPLE + 1)) : 0;
    const sample = await prisma.version.findMany({
      where: { organizationId: org.id, checksum: { not: null } },
      orderBy: { id: "asc" },
      skip,
      take: SAMPLE,
      select: { id: true, storageRef: true, checksum: true, documentId: true },
    });
    let ok = 0;
    for (const v of sample) {
      try {
        const bytes = await driver.get(v.storageRef);
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual === v.checksum) ok++;
        else {
          problems++;
          console.error(`[data-guard] MISMATCH org=${org.id} version=${v.id} doc=${v.documentId} ref=${v.storageRef}`);
        }
      } catch (err) {
        problems++;
        console.error(`[data-guard] MISSING/UNREADABLE org=${org.id} version=${v.id} doc=${v.documentId} ref=${v.storageRef}: ${(err as Error).message}`);
      }
    }
    console.log(`[data-guard] scrub org=${org.id}: ${ok}/${sample.length} verified (of ${total} versions)`);
  }
  return problems;
}

async function run(modes: { manifest: boolean; scrub: boolean }): Promise<number> {
  let problems = 0;
  try {
    if (modes.manifest) await writeManifest();
    if (modes.scrub) problems += await scrub();
  } catch (err) {
    console.error("[data-guard] run failed:", err);
    await ping("/fail");
    return 1;
  }
  await ping(problems > 0 ? "/fail" : "");
  return problems > 0 ? 1 : 0;
}

const modes = {
  manifest: process.argv.includes("--manifest") || !process.argv.includes("--scrub"),
  scrub: process.argv.includes("--scrub") || !process.argv.includes("--manifest"),
};

if (process.argv.includes("--once")) {
  const code = await run(modes);
  await prisma.$disconnect();
  process.exit(code);
}

const [hh, mm] = (process.env.DATA_GUARD_TIME_UTC ?? "01:30").split(":").map(Number);
function msUntilNext(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh ?? 1, mm ?? 30));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
function schedule() {
  const wait = msUntilNext();
  console.log(`[data-guard] next run in ${Math.round(wait / 60000)} min`);
  setTimeout(async () => {
    await run(modes);
    schedule();
  }, wait);
}
schedule();
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
