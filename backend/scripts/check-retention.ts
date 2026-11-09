/**
 * Retention checks — `npm run check:retention` (backend workspace). PRD v1.2.
 *
 * Covers the auto-delete period (RET-1, RET-2, RET-7), the immutable Upload Date and its migration
 * backfill, the daily run (RET-3) and the automatic trash purge, the Upcoming Deletions list (RET-4)
 * and the audit events they write (RET-8 / AUD-1). Legal Hold has its own suite (`check:legal-hold`).
 *
 * Builds two throwaway organizations (never the real "Abate" org) and drives the run with a pinned
 * "now", scoped to the fixture departments — so a period someone set on a real dev department is
 * never acted on by a test.
 *
 * DEV ONLY. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as retention from "../src/modules/retention/retention.service.js";
import * as documents from "../src/modules/document/document.service.js";
import * as departments from "../src/modules/department/department.service.js";
import * as folders from "../src/modules/folder/folder.service.js";
import * as sharing from "../src/modules/sharing/sharing.service.js";
import { createDepartmentSchema } from "../src/modules/department/department.schemas.js";
import {
  addDays,
  autoDeleteDueDate,
  autoDeleteUploadCutoff,
  localDate,
  nextDailyRun,
} from "../src/lib/calendar.js";
import { AUTO_DELETE_TRASH_REASON } from "../src/lib/legal-hold.js";
import {
  buildWorld,
  check,
  destroyWorld,
  expectCode,
  failures,
  ist,
  makeDoc,
  section,
  stamp,
  summary,
  type World,
} from "./_retention-fixtures.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma, env };
const docDeps = { prisma };

let world: World | undefined;
let worldB: World | undefined;

const status = async (id: string) => (await prisma.document.findUnique({ where: { id }, select: { status: true } }))?.status;

try {
  // ───────────────────────── calendar rules ─────────────────────────
  section("calendar: due dates, leap day, time zone");
  check("due date is Upload Date + N years", autoDeleteDueDate("2019-10-30", 7) === "2026-10-30");
  check("29 Feb + 1 year is due on 1 Mar (never early)", autoDeleteDueDate("2024-02-29", 1) === "2025-03-01");
  check("29 Feb + 4 years stays 29 Feb (leap target)", autoDeleteDueDate("2024-02-29", 4) === "2028-02-29");
  check("cut-off on 28 Feb excludes a 29 Feb upload", autoDeleteUploadCutoff("2025-02-28", 1) === "2024-02-28");
  check("cut-off on 1 Mar includes a 29 Feb upload", autoDeleteUploadCutoff("2025-03-01", 1) === "2024-03-01");
  check("cut-off on 29 Feb (leap) → 28 Feb a year earlier", autoDeleteUploadCutoff("2028-02-29", 1) === "2027-02-28");
  check("local date follows the zone, not UTC", localDate(new Date("2026-02-28T18:40:00Z"), "Asia/Kolkata") === "2026-03-01");
  const run = nextDailyRun(ist("2026-10-30T15:00:00"), "02:00", "Asia/Kolkata");
  check("next run after 15:00 IST is 02:00 IST the next day", run.toISOString() === ist("2026-10-31T02:00:00").toISOString(), run.toISOString());
  const early = nextDailyRun(ist("2026-10-30T01:00:00"), "02:00", "Asia/Kolkata");
  check("next run before 02:00 IST is the same day", early.toISOString() === ist("2026-10-30T02:00:00").toISOString(), early.toISOString());

  world = await buildWorld(prisma, env, "ret");
  worldB = await buildWorld(prisma, env, "retb");
  const w = world;
  const wb = worldB;
  const { admin, staff, auditor, viewer, otherAdmin } = w.users;
  const scope = { departmentIds: [w.dept.id, w.dept2.id, wb.dept.id, wb.dept2.id] };

  // ───────────────────────── the setting: defaults ─────────────────────────
  section("auto-delete setting: off by default, never on from a template");
  check("a new department starts with auto-delete off", (await prisma.department.findUniqueOrThrow({ where: { id: w.dept.id } })).autoDeleteYears === null);
  for (const t of departments.listTemplates()) {
    const payload = createDepartmentSchema.parse({
      templateKey: t.key,
      name: `ZZ tpl ${t.key} ${stamp}`,
      idPrefix: `T${t.key.slice(0, 3).toUpperCase()}`,
      subjectTerm: t.subjectTerm,
      identifierTerm: t.identifierTerm,
      documentTypes: t.documentTypes,
      roles: t.roles,
      rules: t.rules,
      members: [],
      // A client trying to switch it on at creation is ignored — the create schema has no such field.
      autoDeleteYears: 5,
    });
    const created = await departments.createDepartment(docDeps, w.superAdmin, payload);
    check(`template "${t.key}" creates a department with auto-delete off`, created.autoDeleteYears === null, String(created.autoDeleteYears));
  }

  // ───────────────────────── the setting: who may change it ─────────────────────────
  section("auto-delete setting: only this department's Department Admin");
  for (const [label, actor] of [
    ["Staff", staff.actor],
    ["a read-only Viewer", viewer.actor],
    ["an Auditor", auditor.actor],
    ["another department's Department Admin", otherAdmin.actor],
    ["the Super Admin (no role here)", w.superAdmin],
  ] as const) {
    await expectCode(`${label} can't change the period`, "forbidden", () =>
      retention.setAutoDeletePeriod(deps, actor, w.dept.id, { autoDeleteYears: 7, confirm: true }),
    );
    await expectCode(`${label} can't read the setting`, "forbidden", () => retention.getAutoDeleteSetting(deps, actor, w.dept.id));
  }
  await expectCode("an organization B admin can't reach organization A's department", "department_not_found", () =>
    retention.setAutoDeletePeriod(deps, wb.users.admin.actor, w.dept.id, { autoDeleteYears: 7, confirm: true }),
  );
  check("…and nothing was saved by any of them", (await prisma.department.findUniqueOrThrow({ where: { id: w.dept.id } })).autoDeleteYears === null);

  // ───────────────────────── preview & confirmation (RET-7) ─────────────────────────
  section("auto-delete setting: preview and explicit confirmation");
  // Due under any period ≤ 10 years: uploaded in 2010. Not due under any period: uploaded now.
  const oldDocs = [];
  for (let i = 0; i < 3; i++) oldDocs.push(await makeDoc(prisma, w, { uploadedAt: ist("2010-05-01T10:00:00") }));
  const vaultOld = await makeDoc(prisma, w, { uploadedAt: ist("2010-05-01T10:00:00"), folderId: w.folders.vault });
  const recent = await makeDoc(prisma, w, { uploadedAt: new Date() });
  // Five years ago plus a week: due under 5 years, not under 10 — the shortening case.
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setUTCFullYear(fiveYearsAgo.getUTCFullYear() - 5);
  fiveYearsAgo.setUTCDate(fiveYearsAgo.getUTCDate() - 7);
  const midDoc = await makeDoc(prisma, w, { uploadedAt: fiveYearsAgo });
  const trashed = await makeDoc(prisma, w, { uploadedAt: ist("2010-05-01T10:00:00") });
  await documents.deleteDocument(docDeps, admin.actor, trashed.id); // already in trash: never counted

  const preview = await retention.previewAutoDelete(deps, admin.actor, w.dept.id, 10);
  check("preview counts every due, unheld, active document (confidential included)", preview.affectedCount === 4, String(preview.affectedCount));
  check("preview says what will happen", preview.message === "4 documents will be moved to Trash at the next daily run.", preview.message);
  check("setting a period requires confirmation", preview.requiresConfirmation === true);

  await expectCode("setting a period without confirmation is refused", "confirmation_required", () =>
    retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 10 }),
  );
  try {
    await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 10 });
  } catch (err) {
    const details = (err as retention.RetentionError).details as { preview?: retention.AutoDeletePreview } | undefined;
    check("the refusal carries the preview count", details?.preview?.affectedCount === 4, JSON.stringify(details));
  }
  check("…and saves nothing", (await prisma.department.findUniqueOrThrow({ where: { id: w.dept.id } })).autoDeleteYears === null);

  const t0 = new Date();
  const saved = await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 10, confirm: true });
  check("with confirmation it is saved", saved.autoDeleteYears === 10 && (await prisma.department.findUniqueOrThrow({ where: { id: w.dept.id } })).autoDeleteYears === 10);
  check("nothing moves to trash when the setting is saved — only at the daily run", (await status(oldDocs[0]!.id)) === "active");

  const shorter = await retention.previewAutoDelete(deps, admin.actor, w.dept.id, 5);
  check("shortening previews the larger count", shorter.affectedCount === 5 && shorter.requiresConfirmation, JSON.stringify(shorter));
  await expectCode("shortening without confirmation is refused", "confirmation_required", () =>
    retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 5 }),
  );
  check("…and leaves the period unchanged", (await prisma.department.findUniqueOrThrow({ where: { id: w.dept.id } })).autoDeleteYears === 10);
  await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 5, confirm: true });
  const longer = await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 12 });
  check("lengthening needs no confirmation", longer.autoDeleteYears === 12);
  const off = await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: null });
  check("switching off needs no confirmation", off.autoDeleteYears === null);
  await expectCode("a period of 0 years is refused", "invalid_period", () =>
    retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 0, confirm: true }),
  );

  const changes = await prisma.auditEvent.findMany({
    where: { organizationId: w.org.id, departmentId: w.dept.id, action: "retention_change", occurredAt: { gte: t0 } },
    orderBy: { occurredAt: "asc" },
    include: { actor: { select: { id: true } } },
  });
  const descriptions = changes.map((c) => c.targetDescription);
  check("audit: set / changed / switched off, each with old and new value", JSON.stringify(descriptions) === JSON.stringify([
    "Auto-delete period set: off → 10 years",
    "Auto-delete period changed: 10 years → 5 years",
    "Auto-delete period changed: 5 years → 12 years",
    "Auto-delete period switched off: 12 years → off",
  ]), JSON.stringify(descriptions));
  check("audit: actor is the Department Admin", changes.every((c) => c.actorType === "user" && c.actorUserId === admin.id));

  section("auto-delete setting: departments and organizations are independent");
  await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 7, confirm: true });
  check("another department in the same organization is untouched", (await prisma.department.findUniqueOrThrow({ where: { id: w.dept2.id } })).autoDeleteYears === null);
  check("organization B's departments are untouched", (await prisma.department.findMany({ where: { organizationId: wb.org.id } })).every((d) => d.autoDeleteYears === null));
  await retention.setAutoDeletePeriod(deps, w.users.otherAdmin.actor, w.dept2.id, { autoDeleteYears: 3, confirm: true });
  check("each department keeps its own period", (await prisma.department.findUniqueOrThrow({ where: { id: w.dept.id } })).autoDeleteYears === 7);
  await retention.setAutoDeletePeriod(deps, w.users.otherAdmin.actor, w.dept2.id, { autoDeleteYears: null });
  await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: null });
  for (const d of [...oldDocs, vaultOld, recent, midDoc]) {
    // Park the preview fixtures in the trash, out of the job's way (it never revisits trashed items).
    await prisma.document.update({ where: { id: d.id }, data: { status: "in_trash", deletedAt: new Date(), trashSource: "user" } });
  }

  // ───────────────────────── Upload Date (RET-2) ─────────────────────────
  section("Upload Date: set once, never changed");
  const created = await documents.createDocument(docDeps, staff.actor, {
    folderId: w.folders.sub,
    documentTypeId: w.docType.id,
    fieldValues: [{ fieldDefId: w.docType.titleFieldId, value: "Upload date probe" }],
    file: { storageRef: `zz/${stamp}/probe-v1`, fileName: "probe.pdf", fileSize: 10, mimeType: "application/pdf" },
  });
  const uploadedAt = created.uploadedAt.getTime();
  check("set on first upload", Math.abs(uploadedAt - Date.now()) < 60_000);
  check("equal to the first version's date", created.versions[0]!.createdAt.getTime() === uploadedAt, `${created.versions[0]!.createdAt.toISOString()} vs ${created.uploadedAt.toISOString()}`);
  const uploadedAtNow = async () => (await prisma.document.findUniqueOrThrow({ where: { id: created.id } })).uploadedAt.getTime();
  await new Promise((r) => setTimeout(r, 20));
  await documents.addVersion(docDeps, staff.actor, created.id, {
    file: { storageRef: `zz/${stamp}/probe-v2`, fileName: "probe-2.pdf", fileSize: 10, mimeType: "application/pdf" },
  });
  check("unchanged by a new version", (await uploadedAtNow()) === uploadedAt);
  await documents.editMetadata(docDeps, staff.actor, created.id, [{ fieldDefId: w.docType.titleFieldId, value: "Renamed probe" }]);
  check("unchanged by a metadata edit", (await uploadedAtNow()) === uploadedAt);
  await folders.moveFolder(docDeps, admin.actor, w.folders.sub, null);
  check("unchanged by a move", (await uploadedAtNow()) === uploadedAt);
  await folders.moveFolder(docDeps, admin.actor, w.folders.sub, w.folders.general);
  await sharing.createShare(docDeps, staff.actor, created.id, { targetType: "user", targetUserId: w.users.admin2.id, permission: "view" });
  check("unchanged by a share", (await uploadedAtNow()) === uploadedAt);
  let triggerRefused = false;
  try {
    await prisma.document.update({ where: { id: created.id }, data: { uploadedAt: new Date("2000-01-01") } });
  } catch {
    triggerRefused = true;
  }
  check("the database itself refuses a change", triggerRefused && (await uploadedAtNow()) === uploadedAt);
  await prisma.document.update({ where: { id: created.id }, data: { status: "in_trash", deletedAt: new Date(), trashSource: "user" } });

  section("Upload Date: migration backfill");
  // Every document outside the fixture organizations existed before this run (or was created since
  // with the column's default, inside the same transaction as its first version). Either way its
  // Upload Date must equal its earliest version's date.
  const [backfill] = await prisma.$queryRaw<{ total: bigint; mismatched: bigint }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE d."uploadedAt" IS DISTINCT FROM COALESCE(
             (SELECT MIN(v."createdAt") FROM "version" v WHERE v."documentId" = d."id"), d."createdAt")) AS mismatched
    FROM "document" d
    WHERE d."organizationId" NOT IN (${w.org.id}, ${wb.org.id})`;
  check(`every existing document's Upload Date is its earliest version's date (${backfill?.total} checked)`, Number(backfill?.mismatched) === 0, `${backfill?.mismatched} mismatched`);

  // ───────────────────────── the daily run (RET-3) ─────────────────────────
  section("daily run: boundaries");
  await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 7, confirm: true });
  const now = ist("2026-10-30T02:00:30"); // the 02:00 IST run on 30 Oct 2026
  const exact = await makeDoc(prisma, w, { uploadedAt: ist("2019-10-30T10:00:00"), versions: 3 });
  const lateEvening = await makeDoc(prisma, w, { uploadedAt: ist("2019-10-30T23:30:00") });
  const dayLater = await makeDoc(prisma, w, { uploadedAt: ist("2019-10-31T00:30:00") });
  // 20:00 UTC on the 30th is 01:30 IST on the 31st — due tomorrow in the organization's zone.
  const utcTrap = await makeDoc(prisma, w, { uploadedAt: new Date("2019-10-30T20:00:00Z") });
  const longAgo = await makeDoc(prisma, w, { uploadedAt: ist("2001-01-01T10:00:00"), folderId: w.folders.sub });
  const vaultDue = await makeDoc(prisma, w, { uploadedAt: ist("2015-06-01T10:00:00"), folderId: w.folders.vault });
  const alreadyTrashed = await makeDoc(prisma, w, { uploadedAt: ist("2012-01-01T10:00:00") });
  await documents.deleteDocument(docDeps, admin.actor, alreadyTrashed.id);
  // Department with the setting off, holding very old documents.
  const offDoc = await makeDoc(prisma, w, {
    uploadedAt: ist("2000-01-01T10:00:00"),
    departmentId: w.dept2.id,
    folderId: w.folders.dept2Root,
    documentTypeId: w.docType3.id,
    titleFieldId: w.docType3.titleFieldId,
  });

  const runStart = new Date();
  const first = await retention.runAutoDelete({ prisma }, { ...scope, now, batchSize: 2 });
  const runEnd = new Date();
  check("a document exactly at the boundary (Upload Date + 7 years = today) is moved", (await status(exact.id)) === "in_trash");
  check("one uploaded late that evening, still that date locally, is moved", (await status(lateEvening.id)) === "in_trash");
  check("one uploaded a day later (due tomorrow) is not", (await status(dayLater.id)) === "active");
  check("one whose UTC date is the boundary but local date is the next day is not", (await status(utcTrap.id)) === "active");
  check("long-expired documents in subfolders are moved", (await status(longAgo.id)) === "in_trash");
  check("confidential documents are moved too (the run is the System, not a viewer)", (await status(vaultDue.id)) === "in_trash");
  check("a department with the setting off is untouched", (await status(offDoc.id)) === "active");
  check("the run processes in batches and reports what it did", first.moved === 4 && first.failed.length === 0, JSON.stringify(first));

  const versions = await prisma.version.findMany({ where: { documentId: exact.id } });
  check("all three versions stay with the document in trash", versions.length === 3);
  const trash = await documents.listTrash(docDeps, admin.actor, w.dept.id);
  const exactItem = trash.find((t) => t.id === exact.id);
  check("trash shows the reason", exactItem?.trashReason === AUTO_DELETE_TRASH_REASON, String(exactItem?.trashReason));
  check("trash shows the System as who deleted it", exactItem?.deletedByName === "System" && exactItem?.trashSource === "auto_delete");
  check("a Department Admin may restore an auto-deleted item", exactItem?.canRestore === true);
  const restorerView = await documents.listTrash(docDeps, w.users.restorer.actor, w.dept.id);
  check("a user with only restore rights may not", restorerView.find((t) => t.id === exact.id)?.canRestore === false);

  const autoEvents = await prisma.auditEvent.findMany({ where: { organizationId: w.org.id, action: "auto_delete" } });
  const exactEvent = autoEvents.find((e) => e.documentId === exact.id);
  check("one audit record per document moved", autoEvents.length === 4, String(autoEvents.length));
  check("audit: actor is the System", autoEvents.every((e) => e.actorType === "system" && e.actorUserId === null));
  check("audit: action, target and time are right", Boolean(
    exactEvent &&
      exactEvent.departmentId === w.dept.id &&
      exactEvent.targetDescription?.startsWith(AUTO_DELETE_TRASH_REASON) &&
      exactEvent.targetDescription.endsWith(`: ${exact.documentRef}`) &&
      exactEvent.occurredAt >= runStart && exactEvent.occurredAt <= runEnd,
  ), JSON.stringify(exactEvent));
  check("audit: a confidential document's event is segregated", autoEvents.find((e) => e.documentId === vaultDue.id)?.isConfidential === true);
  check("a document already in trash is not processed again", (await prisma.document.findUniqueOrThrow({ where: { id: alreadyTrashed.id } })).trashSource === "user" && !autoEvents.some((e) => e.documentId === alreadyTrashed.id));

  section("daily run: idempotent");
  const second = await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("running again the same day moves nothing", second.moved === 0 && second.failed.length === 0, JSON.stringify(second));
  check("and writes no second audit record", (await prisma.auditEvent.count({ where: { organizationId: w.org.id, action: "auto_delete" } })) === 4);
  const nextDay = await retention.runAutoDelete({ prisma }, { ...scope, now: ist("2026-10-31T02:00:30") });
  check("the next day's run picks up what became due", nextDay.moved === 2 && (await status(dayLater.id)) === "in_trash" && (await status(utcTrap.id)) === "in_trash", JSON.stringify(nextDay));

  section("daily run: leap day");
  await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 1, confirm: true });
  const leap = await makeDoc(prisma, w, { uploadedAt: ist("2024-02-29T12:00:00") });
  await retention.runAutoDelete({ prisma }, { ...scope, now: ist("2025-02-28T02:00:30") });
  check("a 29 Feb upload is not deleted on 28 Feb a year later", (await status(leap.id)) === "active");
  await retention.runAutoDelete({ prisma }, { ...scope, now: ist("2025-03-01T02:00:30") });
  check("it is deleted on 1 Mar", (await status(leap.id)) === "in_trash");
  await retention.setAutoDeletePeriod(deps, admin.actor, w.dept.id, { autoDeleteYears: 7, confirm: true });

  section("daily run: one failure doesn't stop the batch");
  const failing = await makeDoc(prisma, w, { uploadedAt: ist("2005-01-01T10:00:00") });
  const sibling1 = await makeDoc(prisma, w, { uploadedAt: ist("2005-01-01T10:00:00") });
  const sibling2 = await makeDoc(prisma, w, { uploadedAt: ist("2005-01-01T10:00:00") });
  // A temporary trigger makes exactly one document's update fail, the way a real fault would.
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION zz_fail_one() RETURNS trigger AS $$
    BEGIN
      IF NEW."id" = '${failing.id}' THEN RAISE EXCEPTION 'simulated failure'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER zz_fail_one BEFORE UPDATE ON "document" FOR EACH ROW EXECUTE FUNCTION zz_fail_one()`);
  let failingRun: retention.AutoDeleteResult;
  try {
    failingRun = await retention.runAutoDelete({ prisma }, { ...scope, now, batchSize: 1 });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_fail_one ON "document"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_fail_one()`);
  }
  check("the failing document is reported", failingRun.failed.length === 1 && failingRun.failed[0]!.documentId === failing.id, JSON.stringify(failingRun.failed));
  check("its neighbours are still moved", (await status(sibling1.id)) === "in_trash" && (await status(sibling2.id)) === "in_trash");
  check("the failing document is left as it was", (await status(failing.id)) === "active");
  const retry = await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("and the next run picks it up", retry.moved === 1 && (await status(failing.id)) === "in_trash");

  section("daily run: tenant isolation");
  // Organization B has a department with a period, and an expired document; org A's department
  // has documents expired under B's (shorter) period that A's period doesn't reach yet.
  await retention.setAutoDeletePeriod(deps, wb.users.admin.actor, wb.dept.id, { autoDeleteYears: 2, confirm: true });
  const bExpired = await makeDoc(prisma, wb, { uploadedAt: ist("2020-01-01T10:00:00") });
  const aNotYet = await makeDoc(prisma, w, { uploadedAt: ist("2023-01-01T10:00:00") });
  // A forged row: organization B, but claiming organization A's department. The run must not
  // treat it as A's (its every query carries the department's organization).
  const forged = await makeDoc(prisma, wb, {
    uploadedAt: ist("2001-01-01T10:00:00"),
    departmentId: w.dept.id,
    folderId: wb.folders.general,
  });
  await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("organization B's expired document is moved by B's own period", (await status(bExpired.id)) === "in_trash");
  check("B's shorter period never reaches organization A's documents", (await status(aNotYet.id)) === "active");
  check("a row of organization B claiming A's department is not touched", (await status(forged.id)) === "active");
  check("organization A's audit holds no record about organization B's documents", (await prisma.auditEvent.count({ where: { organizationId: w.org.id, documentId: { in: [bExpired.id, forged.id] } } })) === 0);

  // ───────────────────────── the automatic trash purge ─────────────────────────
  section("automatic trash purge");
  const day = 24 * 60 * 60 * 1000;
  const old = await makeDoc(prisma, w, { uploadedAt: ist("2010-01-01T10:00:00"), versions: 2 });
  const young = await makeDoc(prisma, w, { uploadedAt: ist("2010-01-01T10:00:00") });
  await prisma.document.update({ where: { id: old.id }, data: { status: "in_trash", deletedAt: new Date(now.getTime() - 31 * day), trashSource: "user", deletedByUserId: staff.id } });
  await prisma.document.update({ where: { id: young.id }, data: { status: "in_trash", deletedAt: new Date(now.getTime() - 29 * day), trashSource: "user", deletedByUserId: staff.id } });
  const oldRef = (await prisma.document.findUniqueOrThrow({ where: { id: old.id } })).documentRef;
  const purgeStart = new Date();
  const purge = await retention.runTrashPurge(deps, { ...scope, now });
  check("an item 31 days in trash is permanently removed", (await prisma.document.findUnique({ where: { id: old.id } })) === null);
  check("its versions are removed with it", (await prisma.version.count({ where: { documentId: old.id } })) === 0);
  check("an item 29 days in trash stays", (await status(young.id)) === "in_trash");
  check("the purge reports what it did", purge.purged >= 1 && purge.failed.length === 0, JSON.stringify(purge));
  const purgeEvent = await prisma.auditEvent.findFirst({ where: { organizationId: w.org.id, action: "purge", targetDescription: { contains: oldRef } } });
  check("audit: one purge record, actor System", purgeEvent?.actorType === "system" && purgeEvent.actorUserId === null);
  check("audit: it survives the document (document link nulled, ref kept)", purgeEvent?.documentId === null && Boolean(purgeEvent?.targetDescription?.includes(oldRef)));
  check("audit: time is the purge's", Boolean(purgeEvent && purgeEvent.occurredAt >= purgeStart));
  const bOld = await makeDoc(prisma, wb, { uploadedAt: ist("2010-01-01T10:00:00") });
  await prisma.document.update({ where: { id: bOld.id }, data: { status: "in_trash", deletedAt: new Date(now.getTime() - 40 * day), trashSource: "user" } });
  await retention.runTrashPurge(deps, { ...scope, now });
  const bEvent = await prisma.auditEvent.findFirst({ where: { action: "purge", targetDescription: { contains: bOld.documentRef } } });
  check("another organization's purge is recorded in that organization only", bEvent?.organizationId === wb.org.id);

  // ───────────────────────── Upcoming Deletions (RET-4) ─────────────────────────
  section("Upcoming Deletions list");
  const listNow = ist("2026-11-10T09:00:00"); // after that day's run: next run is 11 Nov
  const at = (offsetDays: number) => {
    // Upload so that Upload Date + 7 years = listNow's date + offsetDays.
    const due = addDays("2026-11-10", offsetDays);
    return ist(`${Number(due.slice(0, 4)) - 7}${due.slice(4)}T10:00:00`);
  };
  const in5 = await makeDoc(prisma, w, { uploadedAt: at(5), title: "in five" });
  const in30 = await makeDoc(prisma, w, { uploadedAt: at(30), title: "in thirty" });
  const in31 = await makeDoc(prisma, w, { uploadedAt: at(31), title: "in thirty-one" });
  const overdue = await makeDoc(prisma, w, { uploadedAt: at(-3), title: "overdue" });
  const heldSoon = await makeDoc(prisma, w, { uploadedAt: at(10), title: "held" });
  await retention.placeDocumentHold(deps, admin.actor, heldSoon.id, "Litigation");
  const vaultSoon = await makeDoc(prisma, w, { uploadedAt: at(7), folderId: w.folders.vault, title: "vault soon" });

  const upcoming = await retention.listUpcomingDeletions(deps, admin.actor, w.dept.id, listNow);
  const ids = upcoming.items.map((i) => i.id);
  check("shows documents due within 30 days", ids.includes(in5.id) && ids.includes(in30.id));
  check("not one due in 31 days", !ids.includes(in31.id));
  const in5Item = upcoming.items.find((i) => i.id === in5.id);
  check("dates are right: Upload Date, due date, scheduled date", in5Item?.uploadDate === "2019-11-15" && in5Item.dueDate === "2026-11-15" && in5Item.scheduledDate === "2026-11-15", JSON.stringify(in5Item));
  const overdueItem = upcoming.items.find((i) => i.id === overdue.id);
  check("an overdue document is scheduled for the next daily run", overdueItem?.dueDate === "2026-11-07" && overdueItem.scheduledDate === "2026-11-11", JSON.stringify(overdueItem));
  check("sorted by scheduled date", upcoming.items.every((item, i, all) => i === 0 || all[i - 1]!.scheduledDate <= item.scheduledDate));
  check("held documents are listed and clearly marked", upcoming.items.find((i) => i.id === heldSoon.id)?.legalHold === true && upcoming.items.find((i) => i.id === in5.id)?.legalHold === false);
  check("a confidential document is hidden from a Department Admin who isn't a member", !ids.includes(vaultSoon.id));
  const memberView = await retention.listUpcomingDeletions(deps, w.users.vaultAdmin.actor, w.dept.id, listNow);
  check("…and shown to one who is", memberView.items.some((i) => i.id === vaultSoon.id));
  for (const [label, actor] of [["Staff", staff.actor], ["the Super Admin", w.superAdmin], ["another department's admin", otherAdmin.actor]] as const) {
    await expectCode(`${label} can't view the list`, "forbidden", () => retention.listUpcomingDeletions(deps, actor, w.dept.id, listNow));
  }
} catch (err) {
  console.error("TEST ERROR:", err);
  check("suite ran to completion", false, String(err));
} finally {
  // Template-created departments belong to organization A, so `destroyWorld` removes them too.
  await destroyWorld(prisma, world);
  await destroyWorld(prisma, worldB);
  console.log(`\n${summary()}`);
  await prisma.$disconnect();
  process.exit(failures() === 0 ? 0 : 1);
}
