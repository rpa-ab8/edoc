/**
 * Performance targets — `npm run check:performance` (backend workspace).
 *
 * Module 13. Measures the four numbers the PRD's non-functional table commits to:
 *
 *   1. Search returns in under 2 s.
 *   2. A 20-file bulk upload completes in under 2 minutes.
 *   3. An uploaded file is searchable by its OCR text within 5 minutes.
 *   4. (Not measurable here) A single upload takes no more than 3 clicks — a UI property,
 *      verified in the browser pass, not by this script.
 *
 * Reports **actual** numbers, not just pass/fail, because a target met with no headroom is
 * information the pass/fail alone hides. Search is measured against a seeded corpus so the timing
 * means something; the corpus size is deliberately stated in the output.
 *
 * Runs against the real "Abate" org and its verified R2 storage (as `check:upload` does), and
 * removes every row and stored object afterwards. The OCR stage needs the worker running
 * (`npm run worker`) — if nothing consumes the queue the stage reports SKIPPED rather than
 * failing, since an idle worker is an environment fact, not a regression.
 *
 * DEV ONLY, writes to real storage.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as uploads from "../src/modules/upload/upload.service.js";
import * as documents from "../src/modules/document/document.service.js";
import { searchDocuments } from "../src/modules/search/search.service.js";
import { getActiveStorageDriver } from "../src/modules/storage/storage.service.js";
import { getOcrQueue } from "../src/lib/queue.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma };
const fileDeps = { prisma, env };
let pass = 0;
let fail = 0;
let skipped = 0;

/** The PRD's stated targets, in one place so the numbers are auditable against the doc. */
const TARGET_SEARCH_MS = 2_000;
const TARGET_BULK_MS = 120_000;
const TARGET_OCR_MS = 300_000;
const BULK_FILE_COUNT = 20;
const CORPUS_SIZE = 500;

function report(label: string, actual: number, target: number, unit = "ms") {
  const ok = actual <= target;
  const pct = Math.round((actual / target) * 100);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n        ${actual.toFixed(0)}${unit} against a ${target}${unit} target (${pct}% of budget)`,
  );
  if (ok) pass++;
  else fail++;
}
function note(label: string) {
  console.log(`SKIP  ${label}`);
  skipped++;
}

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = process.hrtime.bigint();
  const value = await run();
  return { ms: Number(process.hrtime.bigint() - started) / 1_000_000, value };
}

const stamp = Date.now();
const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });

const dept = await prisma.department.create({
  data: { organizationId: org.id, name: `ZZ Perf ${stamp}`, idPrefix: "ZZP", subfolderDepthLimit: 5 },
});
const docType = await prisma.documentType.create({
  data: {
    departmentId: dept.id,
    name: "Record",
    idCode: "REC",
    fields: {
      create: [
        { label: "Name", fieldType: "text", isRequired: true, isTitle: true, sortOrder: 0 },
        { label: "Reference", fieldType: "id", isRequired: false, sortOrder: 1 },
        { label: "Category", fieldType: "dropdown", isRequired: false, sortOrder: 2, options: ["Alpha", "Beta", "Gamma"] },
      ],
    },
  },
  include: { fields: true },
});
const role = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: dept.id,
    name: "Perf",
    permissions: permissionMapFrom([
      "documents.view", "documents.upload", "documents.preview", "documents.download",
      "documents.edit_metadata", "documents.delete", "documents.restore", "search.search",
    ]) as object,
  },
});
const user = await prisma.user.create({
  data: { email: `zz-perf-${stamp}@example.test`, passwordHash: "x", fullName: "Perf", emailVerifiedAt: new Date() },
});
await prisma.membership.create({
  data: { organizationId: org.id, userId: user.id, departmentId: dept.id, roleId: role.id, status: "active" },
});
const actor: PermissionActor = { userId: user.id, organizationId: org.id, isSuperAdmin: false };
const folder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: dept.id, name: "Perf Folder", depth: 0 },
});

const [nameField, refField, catField] = docType.fields.sort((a, b) => a.sortOrder - b.sortOrder);
const CATEGORIES = ["Alpha", "Beta", "Gamma"];

try {
  // ─────────────────────── 1. search latency (SRCH, <2s) ───────────────────────
  console.log(`\n── seeding a ${CORPUS_SIZE}-document corpus to search against ──`);
  const seedStarted = Date.now();
  let sampleRef = "";
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const created = await documents.createDocument(deps, actor, {
      folderId: folder.id,
      documentTypeId: docType.id,
      fieldValues: [
        { fieldDefId: nameField.id, value: `Performance record ${i} quarterly invoice statement` },
        { fieldDefId: refField.id, value: `PERF-${String(i).padStart(5, "0")}` },
        { fieldDefId: catField.id, value: CATEGORIES[i % CATEGORIES.length] },
      ],
      file: {
        storageRef: `zz-perf/${stamp}/seed-${i}.pdf`,
        fileName: `seed-${i}.pdf`,
        fileSize: 2048,
        mimeType: "application/pdf",
      },
    });
    // Keep one real minted ID from the middle of the corpus — the DOC-3 timing below must search
    // for an ID that actually exists, or it measures the cost of finding nothing.
    if (i === Math.floor(CORPUS_SIZE / 2)) sampleRef = created.documentRef;
  }
  console.log(`        seeded in ${((Date.now() - seedStarted) / 1000).toFixed(1)}s`);

  console.log("\n── 1. search latency (PRD: under 2s) ──");
  // A spread of the query shapes the UI actually issues, each measured separately: a bare listing,
  // search-as-you-type prefixes, a pasted document ID, a dropdown filter, and a filter stack.
  const queries: { label: string; run: () => Promise<unknown[]> }[] = [
    { label: "unfiltered listing (most-recent-first)", run: () => searchDocuments(deps, actor, { departmentId: dept.id }) },
    { label: "single-term text query", run: () => searchDocuments(deps, actor, { departmentId: dept.id, q: "invoice" }) },
    { label: "search-as-you-type prefix ('inv')", run: () => searchDocuments(deps, actor, { departmentId: dept.id, q: "inv" }) },
    { label: "multi-term query", run: () => searchDocuments(deps, actor, { departmentId: dept.id, q: "quarterly invoice statement" }) },
    {
      label: `pasted document ID (DOC-3 path, ${sampleRef})`,
      run: () => searchDocuments(deps, actor, { departmentId: dept.id, q: sampleRef }),
    },
    {
      label: "partial document ID (the ILIKE branch)",
      run: () => searchDocuments(deps, actor, { departmentId: dept.id, q: sampleRef.slice(-5) }),
    },
    {
      label: "exact-ID lookup endpoint (lookupByRef)",
      run: async () => [await documents.lookupByRef(deps, actor, sampleRef)],
    },
    {
      label: "dropdown filter",
      run: () => searchDocuments(deps, actor, { departmentId: dept.id, filters: [{ fieldDefId: catField.id, op: "in", values: ["Beta"] }] }),
    },
    {
      label: "text query + two stacked filters",
      run: () =>
        searchDocuments(deps, actor, {
          departmentId: dept.id,
          q: "record",
          filters: [
            { fieldDefId: catField.id, op: "in", values: ["Alpha", "Gamma"] },
            { fieldDefId: nameField.id, op: "contains", value: "Performance" },
          ],
        }),
    },
  ];

  const timings: number[] = [];
  for (const q of queries) {
    // Three runs, worst kept: a cold first query is the one a user actually feels, but a single
    // sample on a shared dev database is noise. The worst of three is the honest pessimistic read.
    let worst = 0;
    let rows = 0;
    for (let i = 0; i < 3; i++) {
      const t = await timed(q.run);
      worst = Math.max(worst, t.ms);
      rows = t.value.length;
    }
    timings.push(worst);
    report(`${q.label} — ${rows} result(s)`, worst, TARGET_SEARCH_MS);
  }
  const slowest = Math.max(...timings);
  console.log(`\n        slowest query overall: ${slowest.toFixed(0)}ms  ·  corpus: ${CORPUS_SIZE} documents`);

  // ─────────────────────── 2. bulk upload (UPL, 20 files <2min) ───────────────────────
  console.log(`\n── 2. bulk upload of ${BULK_FILE_COUNT} files through real storage (PRD: under 2 min) ──`);
  // Bulk upload is client-side orchestration: each file is one independent call to the single
  // endpoint (Module 6), so this loop is the same work the browser does, minus network latency.
  const perFile: number[] = [];
  const bulk = await timed(async () => {
    for (let i = 0; i < BULK_FILE_COUNT; i++) {
      const bytes = Buffer.from(
        `zz perf bulk ${i} ${stamp} ${"payload ".repeat(400)}`, // ~3KB each, distinct so no dedupe
      );
      const t = await timed(() =>
        uploads.uploadDocument(fileDeps, actor, {
          departmentId: dept.id,
          folderId: folder.id,
          documentTypeId: docType.id,
          fieldValues: [{ fieldDefId: nameField.id, value: `Bulk upload ${i}` }],
          file: { fileName: `bulk-${i}.pdf`, declaredMime: "application/pdf", data: bytes },
        }),
      );
      perFile.push(t.ms);
    }
  });
  report(`${BULK_FILE_COUNT} files uploaded and recorded`, bulk.ms, TARGET_BULK_MS);
  const mean = perFile.reduce((a, b) => a + b, 0) / perFile.length;
  console.log(
    `        per file: mean ${mean.toFixed(0)}ms · fastest ${Math.min(...perFile).toFixed(0)}ms · slowest ${Math.max(...perFile).toFixed(0)}ms`,
  );

  // ─────────────────────── 3. OCR searchable within 5 min (UPL-6) ───────────────────────
  console.log("\n── 3. OCR text searchable after upload (PRD: within 5 min) ──");
  const ocrMarker = `zzocr${stamp}`;
  // A PDF carrying real embedded text: the worker's PDF path extracts it directly, which is the
  // same pipeline an image takes minus Tesseract itself. Built by hand so the file is valid and
  // the marker is genuinely inside the document body, not the filename.
  const pdfBytes = buildTextPdf(`Quarterly report containing the marker ${ocrMarker} inside its body.`);
  const ocrUpload = await uploads.uploadDocument(fileDeps, actor, {
    departmentId: dept.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: nameField.id, value: "OCR probe" }],
    file: { fileName: "ocr-probe.pdf", declaredMime: "application/pdf", data: pdfBytes },
  });
  const ocrDocId = ocrUpload.document!.id;

  const queue = getOcrQueue(env);
  const workers = await queue.getWorkersCount().catch(() => 0);
  if (workers === 0) {
    note(`OCR timing — no worker is consuming the queue (run \`npm run worker\`), so this measures nothing`);
    console.log("        the upload itself succeeded and the job is queued; OCR degrades to metadata-only search (UPL-6)");
  } else {
    const started = Date.now();
    let foundMs: number | null = null;
    // Poll for the marker becoming searchable — the end-to-end property the target is about, not
    // merely the worker finishing: it must reach the search vector too.
    while (Date.now() - started < TARGET_OCR_MS) {
      const hits = await searchDocuments(deps, actor, { departmentId: dept.id, q: ocrMarker });
      if (hits.some((h) => h.id === ocrDocId)) {
        foundMs = Date.now() - started;
        break;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (foundMs === null) {
      const version = await prisma.version.findFirst({
        where: { documentId: ocrDocId },
        select: { ocrStatus: true },
      });
      report(`OCR text searchable (ocrStatus=${version?.ocrStatus ?? "?"})`, TARGET_OCR_MS + 1, TARGET_OCR_MS);
    } else {
      report("OCR text searchable end-to-end", foundMs, TARGET_OCR_MS);
    }
  }

  // ─────────────────────── 4. the click-count target ───────────────────────
  console.log("\n── 4. single upload in 3 clicks or fewer ──");
  note("click count is a UI property — verified in the browser pass, not measurable from the service layer");
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  try {
    const driver = await getActiveStorageDriver(fileDeps, org.id);
    const versions = await prisma.version.findMany({
      where: { document: { departmentId: dept.id } },
      select: { storageRef: true, fileSize: true },
    });
    let total = 0;
    for (const v of versions) {
      total += v.fileSize;
      await driver.delete(v.storageRef).catch(() => {});
    }
    if (total > 0) {
      await prisma.storageConfig.updateMany({
        where: { organizationId: org.id },
        data: { usedBytes: { decrement: BigInt(total) } },
      });
    }
  } catch (err) {
    console.error("[cleanup] storage issue:", err);
  }
  await prisma.auditEvent.deleteMany({ where: { departmentId: dept.id } });
  await prisma.fieldValue.deleteMany({ where: { document: { departmentId: dept.id } } });
  await prisma.share.deleteMany({ where: { document: { departmentId: dept.id } } });
  await prisma.document.updateMany({ where: { departmentId: dept.id }, data: { currentVersionId: null } });
  await prisma.version.deleteMany({ where: { document: { departmentId: dept.id } } });
  await prisma.document.deleteMany({ where: { departmentId: dept.id } });
  await prisma.documentRefSequence.deleteMany({ where: { departmentId: dept.id } });
  await prisma.folder.deleteMany({ where: { departmentId: dept.id } });
  await prisma.membership.deleteMany({ where: { departmentId: dept.id } });
  await prisma.fieldDef.deleteMany({ where: { documentType: { departmentId: dept.id } } });
  await prisma.documentType.deleteMany({ where: { departmentId: dept.id } });
  await prisma.role.deleteMany({ where: { departmentId: dept.id } });
  await prisma.department.deleteMany({ where: { id: dept.id } });
  await prisma.user.deleteMany({ where: { id: user.id } });

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

/** A minimal single-page PDF with the given text as real embedded content, so the worker's
 *  PDF text-extraction path has something genuine to find. */
function buildTextPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
