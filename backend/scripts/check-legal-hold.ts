/**
 * Legal Hold checks — `npm run check:legal-hold` (backend workspace). PRD v1.2 RET-5, RET-6, TRSH-4.
 *
 * A hold must stop every way a document can be destroyed — a person's delete, the daily auto-delete,
 * "Empty trash", a single purge and the automatic trash purge — and only the right people may place
 * or remove one: the Department Admin, or inside a confidential folder its Owner. Also covers
 * restoring an auto-deleted document (Department Admin only, and it places a hold), the audit events
 * holds write, and that audit records outlive a purged document and have no edit/delete path.
 *
 * Builds a throwaway organization (never the real "Abate" org) and scopes every run to it.
 *
 * DEV ONLY. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import * as auditLib from "../src/lib/audit.js";
import * as retention from "../src/modules/retention/retention.service.js";
import * as documents from "../src/modules/document/document.service.js";
import * as folders from "../src/modules/folder/folder.service.js";
import * as audit from "../src/modules/audit/audit.service.js";
import { RESTORED_AFTER_AUTO_DELETE_REASON } from "../src/lib/legal-hold.js";
import {
  buildWorld,
  check,
  destroyWorld,
  expectCode,
  failures,
  ist,
  makeDoc,
  section,
  summary,
  type World,
} from "./_retention-fixtures.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma, env };
const docDeps = { prisma };
let world: World | undefined;

const status = async (id: string) => (await prisma.document.findUnique({ where: { id }, select: { status: true } }))?.status ?? "gone";
const day = 24 * 60 * 60 * 1000;
const old = () => ist("2005-01-01T10:00:00");

try {
  world = await buildWorld(prisma, env, "hold");
  const w = world;
  const { admin, staff, vaultAdmin, restorer, otherAdmin } = w.users;
  const scope = { departmentIds: [w.dept.id, w.dept2.id] };
  const now = ist("2026-10-30T02:00:30");

  section("placing a hold: a reason is mandatory");
  const d1 = await makeDoc(prisma, w, { uploadedAt: new Date() });
  await expectCode("no reason is refused", "reason_required", () => retention.placeDocumentHold(deps, admin.actor, d1.id, undefined));
  await expectCode("a blank reason is refused", "reason_required", () => retention.placeDocumentHold(deps, admin.actor, d1.id, "   "));
  await expectCode("a folder hold needs a reason too", "reason_required", () =>
    retention.placeFolderHold(deps, admin.actor, w.dept.id, w.folders.sub, ""),
  );
  let dbRefusedBlank = false;
  try {
    await prisma.legalHold.create({ data: { organizationId: w.org.id, departmentId: w.dept.id, documentId: d1.id, reason: " ", placedByUserId: admin.id } });
  } catch {
    dbRefusedBlank = true;
  }
  check("the database refuses a blank reason as well", dbRefusedBlank);

  section("placing a hold: who may");
  for (const [label, actor, code] of [
    ["Staff", staff.actor, "forbidden"],
    ["a user with delete/restore rights", restorer.actor, "forbidden"],
    ["another department's Department Admin", otherAdmin.actor, "document_not_found"],
    ["the Super Admin (no role here)", w.superAdmin, "document_not_found"],
  ] as const) {
    await expectCode(`${label} can't place a hold`, code, () => retention.placeDocumentHold(deps, actor, d1.id, "Audit"));
  }
  const t0 = new Date();
  const hold1 = await retention.placeDocumentHold(deps, admin.actor, d1.id, "Litigation: Smith v Acme");
  const t1 = new Date();
  const stored = await prisma.legalHold.findUniqueOrThrow({ where: { id: hold1.id } });
  check("a Department Admin can, and who/when/why is stored", stored.placedByUserId === admin.id && stored.reason === "Litigation: Smith v Acme" && stored.placedAt >= t0 && stored.placedAt <= t1);
  await expectCode("a second hold on the same document is refused", "already_held", () => retention.placeDocumentHold(deps, admin.actor, d1.id, "Again"));
  const placedEvent = await prisma.auditEvent.findFirst({ where: { organizationId: w.org.id, action: "legal_hold_placed", documentId: d1.id } });
  check("audit: placed, with the reason, by the admin, at that time", Boolean(
    placedEvent && placedEvent.actorUserId === admin.id && placedEvent.actorType === "user" &&
      placedEvent.targetDescription?.includes("Litigation: Smith v Acme") && placedEvent.occurredAt >= t0 && placedEvent.occurredAt <= new Date(),
  ));

  section("a held document can't be destroyed");
  await expectCode("a person can't delete it (even with delete rights)", "legal_hold", () => documents.deleteDocument(docDeps, admin.actor, d1.id));
  check("…and it stays active", (await status(d1.id)) === "active");
  const viewerView = await documents.getDocument(docDeps, admin.actor, d1.id);
  check("the viewer reports the hold, with its reason", viewerView.legalHold.held && viewerView.legalHold.holds[0]?.reason === "Litigation: Smith v Acme" && viewerView.legalHold.canManage);
  const staffView = await documents.getDocument(docDeps, staff.actor, d1.id);
  check("staff see the badge but may not manage it", staffView.legalHold.held && !staffView.legalHold.canManage);

  // An expired, held document is skipped by auto-delete.
  await prisma.department.update({ where: { id: w.dept.id }, data: { autoDeleteYears: 7 } });
  const expiredHeld = await makeDoc(prisma, w, { uploadedAt: old() });
  await retention.placeDocumentHold(deps, admin.actor, expiredHeld.id, "Regulator request");
  const autoRun = await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("auto-delete skips a document held directly", (await status(expiredHeld.id)) === "active" && autoRun.skippedHeld >= 1, JSON.stringify(autoRun));

  section("a document already in trash, then held");
  const inTrash = await makeDoc(prisma, w, { uploadedAt: new Date() });
  await documents.deleteDocument(docDeps, admin.actor, inTrash.id);
  const trashHold = await retention.placeDocumentHold(deps, admin.actor, inTrash.id, "Preserve for audit");
  check("it stays in trash", (await status(inTrash.id)) === "in_trash");
  const trashList = await documents.listTrash(docDeps, admin.actor, w.dept.id);
  check("the trash view marks it held", trashList.find((t) => t.id === inTrash.id)?.legalHold === true);
  await expectCode("a Department Admin can't purge it", "legal_hold", () => documents.purgeDocument(deps, admin.actor, inTrash.id));
  const emptied = await documents.emptyTrash(deps, admin.actor, w.dept.id);
  check("Empty trash skips it", emptied.skipped === 1 && (await status(inTrash.id)) === "in_trash", JSON.stringify(emptied));
  await prisma.document.update({ where: { id: inTrash.id }, data: { deletedAt: new Date(now.getTime() - 45 * day) } });
  const purgeRun = await retention.runTrashPurge(deps, { ...scope, now });
  check("the automatic trash purge skips it, however long it waits", (await status(inTrash.id)) === "in_trash" && purgeRun.skippedHeld >= 1, JSON.stringify(purgeRun));
  check("a held document can still be restored (a hold stops destruction, not recovery)", (await documents.restoreDocument(docDeps, admin.actor, inTrash.id)).status === "active");

  section("folder holds cover the subtree, including what comes later");
  const inSub = await makeDoc(prisma, w, { uploadedAt: old(), folderId: w.folders.sub });
  const folderHold = await retention.placeFolderHold(deps, admin.actor, w.dept.id, w.folders.general, "Board investigation");
  await expectCode("a document in a subfolder can't be deleted", "legal_hold", () => documents.deleteDocument(docDeps, admin.actor, inSub.id));
  const laterFolder = await folders.createFolder(docDeps, admin.actor, w.dept.id, { parentFolderId: w.folders.sub, name: "Added later" });
  const addedLater = await documents.createDocument(docDeps, staff.actor, {
    folderId: laterFolder.id,
    documentTypeId: w.docType.id,
    fieldValues: [{ fieldDefId: w.docType.titleFieldId, value: "Filed after the hold" }],
    file: { storageRef: "zz/hold/later", fileName: "later.pdf", fileSize: 10, mimeType: "application/pdf" },
  });
  await expectCode("a document added after the hold, in a subfolder created after it, is covered", "legal_hold", () =>
    documents.deleteDocument(docDeps, admin.actor, addedLater.id),
  );
  const run2 = await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("auto-delete skips documents held through a folder", (await status(inSub.id)) === "active", JSON.stringify(run2));
  const tree = await folders.listFolders(docDeps, admin.actor, w.dept.id);
  check("the folder list marks the held folder and its subtree", tree.find((f) => f.id === w.folders.general)?.legalHold === "held" && tree.find((f) => f.id === w.folders.sub)?.legalHold === "inherited");
  await expectCode("a held folder can't be deleted", "legal_hold", async () => {
    const empty = await folders.createFolder(docDeps, admin.actor, w.dept.id, { parentFolderId: null, name: "Empty held" });
    await retention.placeFolderHold(deps, admin.actor, w.dept.id, empty.id, "Keep");
    return folders.deleteFolder(docDeps, admin.actor, empty.id);
  });
  await expectCode("a subfolder can't be moved out from under the hold", "legal_hold", () => folders.moveFolder(docDeps, admin.actor, w.folders.sub, null));
  check("moving within the held tree is fine", (await folders.moveFolder(docDeps, admin.actor, laterFolder.id, w.folders.general)).moved === true);

  section("removing a hold");
  const r0 = new Date();
  await retention.removeHold(deps, admin.actor, folderHold.id);
  const removed = await prisma.legalHold.findUniqueOrThrow({ where: { id: folderHold.id } });
  check("records who removed it and when", removed.removedByUserId === admin.id && removed.removedAt !== null && removed.removedAt >= r0);
  check("the expired document is not deleted the moment the hold goes", (await status(inSub.id)) === "active");
  await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("the next daily run moves it to trash", (await status(inSub.id)) === "in_trash");
  const removedEvent = await prisma.auditEvent.findFirst({ where: { organizationId: w.org.id, action: "legal_hold_removed", targetDescription: { contains: "Board investigation" } } });
  check("audit: removal, by the admin", removedEvent?.actorUserId === admin.id && removedEvent.occurredAt >= r0);
  await expectCode("a removed hold can't be removed again", "hold_not_found", () => retention.removeHold(deps, admin.actor, folderHold.id));
  await expectCode("staff can't remove a hold", "forbidden", () => retention.removeHold(deps, staff.actor, hold1.id));

  section("confidential folders: only the Owner places and removes holds");
  const vaultDoc = await makeDoc(prisma, w, { uploadedAt: new Date(), folderId: w.folders.vaultSub });
  await expectCode("a named member who is a Department Admin, but not the Owner, can't", "forbidden", () =>
    retention.placeDocumentHold(deps, vaultAdmin.actor, vaultDoc.id, "Member"),
  );
  await expectCode("a Department Admin who isn't on the list can't even see it", "document_not_found", () =>
    retention.placeDocumentHold(deps, admin.actor, vaultDoc.id, "Admin"),
  );
  await expectCode("the Super Admin can't see it", "document_not_found", () => retention.placeDocumentHold(deps, w.superAdmin, vaultDoc.id, "Super"));
  const vaultHold = await retention.placeDocumentHold(deps, staff.actor, vaultDoc.id, "Owner hold");
  check("the Owner can (whatever their department role)", Boolean(vaultHold.id));
  const vaultPlaced = await prisma.auditEvent.findFirst({ where: { organizationId: w.org.id, action: "legal_hold_placed", documentId: vaultDoc.id } });
  check("audit: the event is confidential-segregated", vaultPlaced?.isConfidential === true);
  await expectCode("a non-owner member can't remove it", "forbidden", () => retention.removeHold(deps, vaultAdmin.actor, vaultHold.id));
  await expectCode("a non-member admin gets not-found", "hold_not_found", () => retention.removeHold(deps, admin.actor, vaultHold.id));
  check("the Owner can remove it", (await retention.removeHold(deps, staff.actor, vaultHold.id)).removed === true);
  const vaultFolderHold = await retention.placeFolderHold(deps, staff.actor, w.dept.id, w.folders.vault, "Vault-wide");
  await expectCode("a non-owner can't place a folder hold in the vault", "forbidden", () =>
    retention.placeFolderHold(deps, vaultAdmin.actor, w.dept.id, w.folders.vaultSub, "x"),
  );
  check("admin's hold list doesn't reveal the vault's hold", !(await retention.listHolds(deps, admin.actor, w.dept.id)).some((h) => h.id === vaultFolderHold.id));
  check("a member admin's list does", (await retention.listHolds(deps, vaultAdmin.actor, w.dept.id)).some((h) => h.id === vaultFolderHold.id));
  await retention.removeHold(deps, staff.actor, vaultFolderHold.id);

  section("restoring an auto-deleted document");
  const autoDoc = await makeDoc(prisma, w, { uploadedAt: old() });
  await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("(it was auto-deleted)", (await prisma.document.findUniqueOrThrow({ where: { id: autoDoc.id } })).trashSource === "auto_delete");
  await expectCode("a user with restore rights, not a Department Admin, can't restore it", "forbidden", () =>
    documents.restoreDocument(docDeps, restorer.actor, autoDoc.id),
  );
  const rs0 = new Date();
  const restored = await documents.restoreDocument(docDeps, admin.actor, autoDoc.id);
  check("a Department Admin can; it returns to its original folder", restored.status === "active" && restored.folderId === w.folders.general && restored.trashSource === null);
  const autoHold = await prisma.legalHold.findFirst({ where: { documentId: autoDoc.id, removedAt: null } });
  check("…and a Legal Hold is placed automatically", autoHold?.reason === RESTORED_AFTER_AUTO_DELETE_REASON && autoHold.placedByUserId === admin.id);
  await retention.runAutoDelete({ prisma }, { ...scope, now });
  check("the hold survives the next daily run — it isn't deleted again", (await status(autoDoc.id)) === "active");
  const restoreEvent = await prisma.auditEvent.findFirst({ where: { organizationId: w.org.id, action: "restore", documentId: autoDoc.id } });
  check("audit: restore of an auto-deleted document, by the admin", restoreEvent?.actorUserId === admin.id && Boolean(restoreEvent.targetDescription?.startsWith("Restored after auto-delete")) && restoreEvent.occurredAt >= rs0);
  check("audit: the automatic hold is recorded with its reason", Boolean(await prisma.auditEvent.findFirst({ where: { documentId: autoDoc.id, action: "legal_hold_placed", targetDescription: { contains: RESTORED_AFTER_AUTO_DELETE_REASON } } })));

  const vaultAuto = await makeDoc(prisma, w, { uploadedAt: old(), folderId: w.folders.vault });
  await retention.runAutoDelete({ prisma }, { ...scope, now });
  await expectCode("in a vault, a member Department Admin who isn't the Owner can't restore it", "forbidden", () =>
    documents.restoreDocument(docDeps, vaultAdmin.actor, vaultAuto.id),
  );
  await prisma.membership.updateMany({ where: { userId: staff.id, departmentId: w.dept.id }, data: { roleId: w.roles.staffRestore } });
  check("the vault's Owner can", (await documents.restoreDocument(docDeps, staff.actor, vaultAuto.id)).status === "active");
  await prisma.membership.updateMany({ where: { userId: staff.id, departmentId: w.dept.id }, data: { roleId: w.roles.staff } });

  section("ordinary restore is unchanged");
  const userDeleted = await makeDoc(prisma, w, { uploadedAt: new Date() });
  await documents.deleteDocument(docDeps, admin.actor, userDeleted.id);
  check("a user with restore rights still restores a user-deleted document", (await documents.restoreDocument(docDeps, restorer.actor, userDeleted.id)).status === "active");
  check("…and no hold is placed", (await prisma.legalHold.count({ where: { documentId: userDeleted.id } })) === 0);

  section("audit records: confidential segregation, immutability, and surviving a purge");
  const vaultDel = await makeDoc(prisma, w, { uploadedAt: new Date(), folderId: w.folders.vault });
  await documents.deleteDocument(docDeps, vaultAdmin.actor, vaultDel.id);
  const delEvent = await prisma.auditEvent.findFirst({ where: { documentId: vaultDel.id, action: "delete" } });
  check("deleting a confidential document now writes a confidential event", delEvent?.isConfidential === true);
  const ordinary = await audit.listAudit(docDeps, w.users.auditor.actor, w.dept.id, {});
  check("…which an ordinary audit viewer (no confidential-audit right) doesn't see", !ordinary.events.some((e) => e.id === delEvent?.id));
  const privileged = await audit.listAudit(docDeps, admin.actor, w.dept.id, {});
  check("…and a holder of the confidential-audit right does", privileged.events.some((e) => e.id === delEvent?.id));

  const purgeMe = await makeDoc(prisma, w, { uploadedAt: new Date() });
  await retention.placeDocumentHold(deps, admin.actor, purgeMe.id, "Brief hold");
  const purgeHold = await prisma.legalHold.findFirstOrThrow({ where: { documentId: purgeMe.id, removedAt: null } });
  await retention.removeHold(deps, admin.actor, purgeHold.id);
  await documents.deleteDocument(docDeps, admin.actor, purgeMe.id);
  await documents.purgeDocument(deps, admin.actor, purgeMe.id);
  const surviving = await prisma.auditEvent.findMany({ where: { organizationId: w.org.id, targetDescription: { contains: purgeMe.documentRef } } });
  const actions = new Set(surviving.map((e) => e.action));
  check("after a permanent removal, its hold and delete events all remain", ["legal_hold_placed", "legal_hold_removed", "delete"].every((a) => actions.has(a as never)), [...actions].join(","));
  check("…with the document link nulled, not the row removed", surviving.every((e) => e.documentId === null));
  check("the audit module exposes no update or delete", Object.keys(auditLib).every((k) => !/update|delete|remove|edit/i.test(k)));

  const app = buildApp(env, prisma, new Redis(env.REDIS_URL, { lazyConnect: true }));
  await app.ready();
  const someEvent = surviving[0]!;
  const routes = [
    { method: "PATCH", url: `/departments/${w.dept.id}/audit/${someEvent.id}` },
    { method: "PUT", url: `/departments/${w.dept.id}/audit/${someEvent.id}` },
    { method: "DELETE", url: `/departments/${w.dept.id}/audit/${someEvent.id}` },
    { method: "DELETE", url: `/departments/${w.dept.id}/audit` },
  ] as const;
  for (const r of routes) {
    const res = await app.inject({ method: r.method, url: r.url });
    check(`no API route can ${r.method} an audit record`, res.statusCode === 404, `${res.statusCode}`);
  }
  await app.close();
} catch (err) {
  console.error("TEST ERROR:", err);
  check("suite ran to completion", false, String(err));
} finally {
  await destroyWorld(prisma, world);
  console.log(`\n${summary()}`);
  await prisma.$disconnect();
  process.exit(failures() === 0 ? 0 : 1);
}
