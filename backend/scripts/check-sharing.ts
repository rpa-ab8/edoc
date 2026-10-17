/**
 * Sharing-module checks — `npm run check:sharing` (backend workspace).
 *
 * Covers Module 9: internal user/department shares (by reference), cross-department two-sided
 * consent, external secure links (permission + department-rule gating, mandatory expiry,
 * confidential block, opened count), revoke/downgrade/extend, and expiry. Uploads real files to the
 * org's storage for the link file-serving tests, then deletes them and reverts usage.
 *
 * DEV ONLY, writes to real storage. Point it at a development environment.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as uploads from "../src/modules/upload/upload.service.js";
import * as documents from "../src/modules/document/document.service.js";
import { DocumentError } from "../src/modules/document/document.service.js";
import * as sharing from "../src/modules/sharing/sharing.service.js";
import { SharingError } from "../src/modules/sharing/sharing.service.js";
import { getActiveStorageDriver } from "../src/modules/storage/storage.service.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

const prisma = new PrismaClient();
const env = loadEnv();
const deps = { prisma };
const fileDeps = { prisma, env };
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + extra}`);
  if (ok) pass++;
  else fail++;
}
async function expectError(label: string, code: string, run: () => Promise<unknown>) {
  try {
    await run();
    check(label, false, "no error thrown");
  } catch (err) {
    const actual =
      err instanceof SharingError || err instanceof DocumentError ? err.code : String(err);
    check(label, actual === code, `expected ${code}, got ${actual}`);
  }
}

const org = await prisma.organization.findFirstOrThrow({ where: { name: "Abate" } });

// Two departments: A is the document's home, B is another department (for cross-department tests).
const deptA = await prisma.department.create({
  data: {
    organizationId: org.id,
    name: "ZZ Share A",
    idPrefix: "ZSA",
    subfolderDepthLimit: 5,
    // External links start OFF so the disabled-gate is exercised before it is turned on.
    rules: { defaultSharing: { externalLinksEnabled: false, linkExpiryDays: 7 } },
  },
});
const deptB = await prisma.department.create({
  data: { organizationId: org.id, name: "ZZ Share B", idPrefix: "ZSB", subfolderDepthLimit: 5 },
});

const docType = await prisma.documentType.create({
  data: {
    departmentId: deptA.id,
    name: "Doc",
    idCode: "DOC",
    fields: { create: [{ label: "Name", fieldType: "text", isTitle: true, sortOrder: 0 }] },
  },
  include: { fields: true },
});

const sharerRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: deptA.id,
    name: "Sharer",
    permissions: permissionMapFrom([
      "documents.view",
      "documents.upload",
      "documents.preview",
      "documents.download",
      "documents.version_history",
      "sharing.share",
      "sharing.external_share",
      "sharing.create_link",
      "sharing.cross_department_share",
    ]) as object,
  },
});
const viewOnlyRoleA = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: deptA.id,
    name: "View only A",
    permissions: permissionMapFrom(["documents.view", "documents.preview"]) as object,
  },
});
const shareNoDownloadRole = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: deptA.id,
    name: "Share no download",
    permissions: permissionMapFrom(["documents.view", "documents.preview", "sharing.share"]) as object,
  },
});
const roleB = await prisma.role.create({
  data: {
    organizationId: org.id,
    departmentId: deptB.id,
    name: "Member B",
    permissions: permissionMapFrom([
      "documents.view",
      "documents.preview",
      "documents.download",
      "sharing.share",
      "sharing.cross_department_share",
    ]) as object,
  },
});

async function makeUser(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: "x", fullName: email.split("@")[0], emailVerifiedAt: new Date() },
  });
}
async function member(userId: string, departmentId: string, roleId: string) {
  await prisma.membership.create({
    data: { organizationId: org.id, userId, departmentId, roleId, status: "active" },
  });
}

const sharerUser = await makeUser("zz-share-sharer@example.test");
await member(sharerUser.id, deptA.id, sharerRole.id);
const sharer: PermissionActor = { userId: sharerUser.id, organizationId: org.id, isSuperAdmin: false };

const viewerAUser = await makeUser("zz-share-viewera@example.test");
await member(viewerAUser.id, deptA.id, viewOnlyRoleA.id);
const viewerA: PermissionActor = { userId: viewerAUser.id, organizationId: org.id, isSuperAdmin: false };

const noDownloadUser = await makeUser("zz-share-nodl@example.test");
await member(noDownloadUser.id, deptA.id, shareNoDownloadRole.id);
const noDownload: PermissionActor = { userId: noDownloadUser.id, organizationId: org.id, isSuperAdmin: false };

const recipientUser = await makeUser("zz-share-recipient@example.test");
await member(recipientUser.id, deptB.id, roleB.id);
const recipient: PermissionActor = { userId: recipientUser.id, organizationId: org.id, isSuperAdmin: false };

const strangerUser = await makeUser("zz-share-stranger@example.test");

const folder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: deptA.id, name: "General", depth: 0 },
});
const confidentialFolder = await prisma.folder.create({
  data: { organizationId: org.id, departmentId: deptA.id, name: "Vault", depth: 0, isConfidential: true },
});
await prisma.confidentialMember.create({ data: { folderId: confidentialFolder.id, userId: sharerUser.id } });

const bytes = Buffer.from("zz sharing payload " + Date.now());

try {
  const up = await uploads.uploadDocument(fileDeps, sharer, {
    departmentId: deptA.id,
    folderId: folder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: docType.fields[0].id, value: "Shared Doc" }],
    file: { fileName: "shared.pdf", declaredMime: "application/pdf", data: bytes },
  });
  const docId = up.document!.id;

  // ── baseline: a recipient with no role reach cannot see the document ──
  await expectError("recipient can't see the doc before any share", "document_not_found", () =>
    documents.getDocument(deps, recipient, docId),
  );

  // ── internal user share (SHR-1/2) ──
  const created = await sharing.createShare(deps, sharer, docId, { targetType: "user", targetUserId: recipientUser.id, permission: "view" });
  check("user share created active", created.share.status === "active" && created.share.permission === "view");

  const recDetail = await documents.getDocument(deps, recipient, docId);
  check("recipient can now view via the share", recDetail.permissions["documents.view"] === true);
  check("share is read-only — no edit", recDetail.permissions["documents.edit_metadata"] !== true);
  check("view-only share grants no download", recDetail.permissions["documents.download"] !== true);

  check(
    "recipient can preview the shared file",
    (await documents.getDocumentFile(fileDeps, recipient, docId, undefined, "preview")).fileName === "shared.pdf",
  );
  await expectError("view-only share can't download (403)", "forbidden", () =>
    documents.getDocumentFile(fileDeps, recipient, docId, undefined, "download"),
  );

  // ── downgrade/upgrade (SHR-6) ──
  await sharing.updateShare(deps, sharer, created.share.id, { permission: "download" });
  const afterUpgrade = await documents.getDocument(deps, recipient, docId);
  check("upgraded share now grants download", afterUpgrade.permissions["documents.download"] === true);

  const withMe = await sharing.listSharedWithMe(deps, recipient);
  check("shared-with-me lists the share", withMe.some((s) => s.documentId === docId));
  const byMe = await sharing.listSharedByMe(deps, sharer);
  check("shared-by-me lists the share", byMe.some((s) => s.id === created.share.id));

  // ── revoke is instant and complete (SHR-1) ──
  await sharing.revokeShare(deps, sharer, created.share.id);
  await expectError("revoked share removes access at once", "document_not_found", () =>
    documents.getDocument(deps, recipient, docId),
  );

  // ── guardrails on creating a share ──
  await expectError("a member without sharing.share can't share (403)", "forbidden", () =>
    sharing.createShare(deps, viewerA, docId, { targetType: "user", targetUserId: recipientUser.id, permission: "view" }),
  );
  await expectError("can't grant download without holding it (403)", "forbidden", () =>
    sharing.createShare(deps, noDownload, docId, { targetType: "user", targetUserId: recipientUser.id, permission: "download" }),
  );
  await expectError("can't share with yourself", "cannot_share_with_self", () =>
    sharing.createShare(deps, sharer, docId, { targetType: "user", targetUserId: sharerUser.id, permission: "view" }),
  );
  await expectError("can't share with a non-org user", "user_not_found", () =>
    sharing.createShare(deps, sharer, docId, { targetType: "user", targetUserId: strangerUser.id, permission: "view" }),
  );
  // Sharing with someone who already has access is allowed (an additive "Shared with me" pointer),
  // not refused — it just can't reduce what their own role already grants.
  {
    const redundant = await sharing.createShare(deps, sharer, docId, {
      targetType: "user",
      targetUserId: viewerAUser.id,
      permission: "view",
    });
    check("sharing with an existing-access user is allowed", redundant.share.status === "active");
    await sharing.revokeShare(deps, sharer, redundant.share.id);
  }

  // ── cross-department share needs two-sided consent (SHR-3) ──
  const cross = await sharing.createShare(deps, sharer, docId, { targetType: "department", targetDepartmentId: deptB.id, permission: "view" });
  check("cross-department share lands pending", cross.share.status === "pending");
  await expectError("a pending cross-dept share grants no access yet", "document_not_found", () =>
    documents.getDocument(deps, recipient, docId),
  );
  const pending = await sharing.listPendingForDepartment(deps, recipient, deptB.id);
  check("receiving department sees the pending share", pending.some((s) => s.id === cross.share.id));

  await sharing.respondToCrossDepartmentShare(deps, recipient, deptB.id, cross.share.id, true);
  const afterAccept = await documents.getDocument(deps, recipient, docId);
  check("accepted department share grants the whole department access", afterAccept.permissions["documents.view"] === true);

  // refuse a second cross-dept share
  await sharing.revokeShare(deps, sharer, cross.share.id); // clear the accepted one first
  const cross2 = await sharing.createShare(deps, sharer, docId, { targetType: "department", targetDepartmentId: deptB.id, permission: "view" });
  await sharing.respondToCrossDepartmentShare(deps, recipient, deptB.id, cross2.share.id, false);
  await expectError("a refused cross-dept share grants no access", "document_not_found", () =>
    documents.getDocument(deps, recipient, docId),
  );

  // ── external secure link (SHR-4/5) ──
  await expectError("external link blocked when the department disallows it", "external_links_disabled", () =>
    sharing.createShare(deps, sharer, docId, { targetType: "external_link", permission: "view" }),
  );

  // turn external links on for department A
  await prisma.department.update({
    where: { id: deptA.id },
    data: { rules: { defaultSharing: { externalLinksEnabled: true, linkExpiryDays: 7 } } },
  });

  const link = await sharing.createShare(deps, sharer, docId, { targetType: "external_link", permission: "view" });
  check("external link created with a token", typeof link.linkToken === "string" && link.linkToken.length > 0);
  check("external link has a mandatory expiry", link.share.expiresAt !== null);

  const opened = await sharing.openLink(deps, link.linkToken!);
  check("opening the link returns the document ref", opened.documentRef === up.document!.documentRef);
  const byMeAfterOpen = await sharing.listSharedByMe(deps, sharer);
  const linkRow = byMeAfterOpen.find((s) => s.id === link.share.id);
  check("opened count increments on open (SHR-6)", linkRow?.openedCount === 1);

  check(
    "external link can preview the file",
    Buffer.from((await sharing.fetchLinkFile(fileDeps, link.linkToken!, "preview")).buffer).equals(bytes),
  );
  await expectError("a view-only link can't download", "download_not_allowed", () =>
    sharing.fetchLinkFile(fileDeps, link.linkToken!, "download"),
  );

  const dlLink = await sharing.createShare(deps, sharer, docId, { targetType: "external_link", permission: "download" });
  check(
    "a download link can download the file",
    Buffer.from((await sharing.fetchLinkFile(fileDeps, dlLink.linkToken!, "download")).buffer).equals(bytes),
  );

  // revoked link is dead
  await sharing.revokeShare(deps, sharer, dlLink.share.id);
  await expectError("a revoked link no longer resolves", "link_unavailable", () =>
    sharing.openLink(deps, dlLink.linkToken!),
  );

  // ── confidential documents can never leave by external link (§11.2) ──
  // Distinct bytes so UPL-4 duplicate detection (same-checksum within a department) doesn't fire
  // and suppress the create.
  const vaultBytes = Buffer.from("zz vault payload " + Date.now());
  const confUp = await uploads.uploadDocument(fileDeps, sharer, {
    departmentId: deptA.id,
    folderId: confidentialFolder.id,
    documentTypeId: docType.id,
    fieldValues: [{ fieldDefId: docType.fields[0].id, value: "Vault Doc" }],
    file: { fileName: "vault.pdf", declaredMime: "application/pdf", data: vaultBytes },
  });
  await expectError("external link refused for a confidential document", "forbidden", () =>
    sharing.createShare(deps, sharer, confUp.document!.id, { targetType: "external_link", permission: "view" }),
  );
  // but an internal share of a confidential doc by a named member is allowed
  const confShare = await sharing.createShare(deps, sharer, confUp.document!.id, { targetType: "user", targetUserId: recipientUser.id, permission: "view" });
  check("internal share of a confidential doc is allowed for a named member", confShare.share.status === "active");
  // ...and it does NOT pierce confidentiality — the recipient (not on the named list) still can't open it
  await expectError("a share can't pierce a confidential folder", "document_not_found", () =>
    documents.getDocument(deps, recipient, confUp.document!.id),
  );

  // ── recipient can tidy their own "Shared with me" (dismiss) ──
  const toDismiss = await sharing.createShare(deps, sharer, docId, { targetType: "user", targetUserId: recipientUser.id, permission: "view" });
  const withMeBefore = await sharing.listSharedWithMe(deps, recipient);
  check("a fresh share appears in the recipient's inbox", withMeBefore.some((s) => s.id === toDismiss.share.id));
  await sharing.dismissShare(deps, recipient, toDismiss.share.id);
  const withMeAfter = await sharing.listSharedWithMe(deps, recipient);
  check("dismissing removes it from the recipient's inbox", !withMeAfter.some((s) => s.id === toDismiss.share.id));
  check("but dismissing doesn't revoke access", (await documents.getDocument(deps, recipient, docId)).permissions["documents.view"] === true);
  await expectError("only the recipient can dismiss", "forbidden", () =>
    sharing.dismissShare(deps, sharer, toDismiss.share.id),
  );
  await sharing.revokeShare(deps, sharer, toDismiss.share.id);

  // ── expired shares are swept away automatically on the next list load ──
  const expiring = await sharing.createShare(deps, sharer, docId, { targetType: "user", targetUserId: recipientUser.id, permission: "view" });
  await prisma.share.update({ where: { id: expiring.share.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await expectError("an expired share grants no access", "document_not_found", () =>
    documents.getDocument(deps, recipient, docId),
  );
  await sharing.listSharedByMe(deps, sharer); // triggers the lazy purge
  const stillThere = await prisma.share.findUnique({ where: { id: expiring.share.id } });
  check("an expired share is auto-removed from the database", stillThere === null);
} catch (err) {
  console.error("TEST ERROR:", err);
  fail++;
} finally {
  try {
    const driver = await getActiveStorageDriver(fileDeps, org.id);
    const versions = await prisma.version.findMany({
      where: { document: { departmentId: { in: [deptA.id, deptB.id] } } },
      select: { storageRef: true, fileSize: true },
    });
    let total = 0;
    for (const v of versions) {
      total += v.fileSize;
      await driver.delete(v.storageRef).catch(() => {});
    }
    await prisma.storageConfig.updateMany({ where: { organizationId: org.id }, data: { usedBytes: { decrement: BigInt(total) } } });
    console.log(`\n[cleanup] removed ${versions.length} object(s), reverted ${total} bytes`);
  } catch (err) {
    console.error("[cleanup] storage issue:", err);
  }

  const deptIds = [deptA.id, deptB.id];
  await prisma.share.deleteMany({ where: { document: { departmentId: { in: deptIds } } } });
  await prisma.confidentialMember.deleteMany({ where: { folder: { departmentId: { in: deptIds } } } });
  await prisma.fieldValue.deleteMany({ where: { document: { departmentId: { in: deptIds } } } });
  await prisma.auditEvent.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.document.updateMany({ where: { departmentId: { in: deptIds } }, data: { currentVersionId: null } });
  await prisma.version.deleteMany({ where: { document: { departmentId: { in: deptIds } } } });
  await prisma.document.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.documentRefSequence.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.folder.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.membership.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.fieldDef.deleteMany({ where: { documentType: { departmentId: { in: deptIds } } } });
  await prisma.documentType.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.role.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
  await prisma.user.deleteMany({
    where: { id: { in: [sharerUser.id, viewerAUser.id, noDownloadUser.id, recipientUser.id, strangerUser.id] } },
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
