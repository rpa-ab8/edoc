/**
 * Shared fixtures for the PRD v1.2 suites (`check:retention`, `check:legal-hold`, `check:filters`).
 *
 * Builds a complete, throwaway organization — never the real "Abate" org — so the daily run can be
 * exercised against data whose Upload Dates the test chooses. Upload Date is immutable (a DB trigger
 * refuses any change), so a document "uploaded seven years ago" is created with that date rather
 * than back-dated afterwards. Files are stand-in storage refs in a scratch NAS folder: nothing here
 * needs real bytes, and the purge path tolerates a missing object by design.
 *
 * DEV ONLY. Point it at a development database.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { purgeTestAuditEvents } from "./_audit-purge.js";
import type { Env } from "../src/config/env.js";
import { encryptJson } from "../src/lib/crypto.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
import { listTemplates } from "../src/modules/department/department.service.js";
import type { PermissionActor } from "../src/lib/effective-permissions.js";

export const stamp = `${Date.now()}`;

let passCount = 0;
let failCount = 0;

export function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + extra}`);
  if (ok) passCount++;
  else failCount++;
}

export function failures() {
  return failCount;
}

export function summary() {
  return `${passCount} passed, ${failCount} failed`;
}

/** Asserts a call is refused with a specific error code. */
export async function expectCode(label: string, code: string, run: () => Promise<unknown>) {
  try {
    const result = await run();
    check(label, false, `no error thrown, returned ${JSON.stringify(result)?.slice(0, 160)}`);
  } catch (err) {
    const actual = (err as { code?: string }).code ?? String(err);
    check(label, actual === code, `expected ${code}, got ${actual}: ${(err as Error).message}`);
  }
}

export function section(title: string) {
  console.log(`\n── ${title} ──`);
}

/** An instant from a local wall-clock time in Asia/Kolkata (UTC+05:30, no DST). */
export function ist(dateTime: string): Date {
  return new Date(`${dateTime}+05:30`);
}

// The template's starter roles, verbatim — so a test of "the Department Admin" exercises exactly
// what a real department gets, including the three retention rights (Change 8).
const template = listTemplates().find((t) => t.key !== "blank") ?? listTemplates()[0]!;
const templateRole = (name: string) => {
  const role = template.roles.find((r) => r.name === name);
  if (!role) throw new Error(`template has no "${name}" role`);
  return role.permissions;
};
const AUDITOR_KEYS = ["documents.view", "documents.preview", "documents.version_history", "search.search", "search.advanced_search", "audit.view_audit"];
const VIEWER_KEYS = ["documents.view", "documents.preview", "search.search"];

export interface World {
  org: { id: string; name: string };
  owner: { id: string };
  superAdmin: PermissionActor;
  dept: { id: string };
  dept2: { id: string };
  docType: { id: string; titleFieldId: string; categoryFieldId: string };
  docType2: { id: string; titleFieldId: string };
  docType3: { id: string; titleFieldId: string }; // in dept2
  roles: { admin: string; staff: string; auditor: string; viewer: string; staffRestore: string; admin2: string };
  users: Record<"admin" | "admin2" | "staff" | "auditor" | "viewer" | "vaultAdmin" | "outsider" | "otherAdmin" | "restorer", { id: string; actor: PermissionActor }>;
  folders: { general: string; sub: string; vault: string; vaultSub: string; dept2Root: string };
  storageDir: string;
}

let docCounter = 0;

/**
 * One organization, two departments, the template's roles, a user per role, and folders:
 *   General ─ Sub        (ordinary)
 *   Vault  ─ VaultSub    (confidential; Owner = `staff`, members `vaultAdmin` and `restorer`)
 */
export async function buildWorld(prisma: PrismaClient, env: Env, tag: string, timeZone = "Asia/Kolkata"): Promise<World> {
  const mk = (who: string) =>
    prisma.user.create({
      data: { email: `zz-${tag}-${who}-${stamp}@example.test`, passwordHash: "x", fullName: `${tag} ${who}`, emailVerifiedAt: new Date() },
    });

  const owner = await mk("owner");
  const org = await prisma.organization.create({
    data: { name: `ZZ ${tag} ${stamp}`, industry: "test", createdByUserId: owner.id, subfolderDepthLimit: 5, timeZone },
  });

  const storageDir = path.join(tmpdir(), `edoc-check-${tag}-${stamp}`);
  mkdirSync(storageDir, { recursive: true });
  await prisma.storageConfig.create({
    data: {
      organizationId: org.id,
      backendType: "nas",
      credentials: { enc: encryptJson(env, { backendType: "nas", mountPath: storageDir }) },
      status: "verified",
    },
  });

  const prefix = `Z${tag.slice(0, 3).toUpperCase()}`;
  const dept = await prisma.department.create({ data: { organizationId: org.id, name: `${tag} One`, idPrefix: `${prefix}1`, subfolderDepthLimit: 5 } });
  const dept2 = await prisma.department.create({ data: { organizationId: org.id, name: `${tag} Two`, idPrefix: `${prefix}2`, subfolderDepthLimit: 5 } });

  const docTypeRow = await prisma.documentType.create({
    data: {
      departmentId: dept.id,
      name: "Invoice",
      idCode: "INV",
      fields: {
        create: [
          { label: "Title", fieldType: "text", isTitle: true, sortOrder: 0 },
          { label: "Category", fieldType: "dropdown", options: ["Red", "Blue"], sortOrder: 1 },
        ],
      },
    },
    include: { fields: true },
  });
  const docType2Row = await prisma.documentType.create({
    data: { departmentId: dept.id, name: "Contract", idCode: "CON", fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, sortOrder: 0 }] } },
    include: { fields: true },
  });
  const docType3Row = await prisma.documentType.create({
    data: { departmentId: dept2.id, name: "Memo", idCode: "MEM", fields: { create: [{ label: "Title", fieldType: "text", isTitle: true, sortOrder: 0 }] } },
    include: { fields: true },
  });

  const role = (departmentId: string, name: string, permissions: object) =>
    prisma.role.create({ data: { organizationId: org.id, departmentId, name, permissions } });
  const adminRole = await role(dept.id, "Department Admin", templateRole("Department Admin"));
  const staffRole = await role(dept.id, "Staff", templateRole("Staff"));
  const auditorRole = await role(dept.id, "Auditor", permissionMapFrom(AUDITOR_KEYS));
  const viewerRole = await role(dept.id, "Viewer", permissionMapFrom(VIEWER_KEYS));
  // Staff who may also delete and restore — the "anyone with delete rights can restore" tier.
  const staffRestoreRole = await role(
    dept.id,
    "Staff + restore",
    permissionMapFrom([...Object.keys(templateRole("Staff")).filter((k) => templateRole("Staff")[k]), "documents.delete", "documents.restore"]),
  );
  const admin2Role = await role(dept2.id, "Department Admin", templateRole("Department Admin"));

  const member = async (who: string, departmentId: string, roleId: string) => {
    const user = await mk(who);
    await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, departmentId, roleId, status: "active" } });
    return { id: user.id, actor: { userId: user.id, organizationId: org.id, isSuperAdmin: false } };
  };
  const users = {
    admin: await member("admin", dept.id, adminRole.id),
    admin2: await member("admin2", dept.id, adminRole.id),
    staff: await member("staff", dept.id, staffRole.id),
    auditor: await member("auditor", dept.id, auditorRole.id),
    viewer: await member("viewer", dept.id, viewerRole.id),
    vaultAdmin: await member("vaultadmin", dept.id, adminRole.id),
    outsider: await member("outsider", dept2.id, admin2Role.id), // dept2 member only
    otherAdmin: await member("otheradmin", dept2.id, admin2Role.id), // Department Admin of the *other* department
    restorer: await member("restorer", dept.id, staffRestoreRole.id),
  };

  const folder = (departmentId: string, name: string, parentFolderId: string | null, depth: number, isConfidential = false) =>
    prisma.folder.create({ data: { organizationId: org.id, departmentId, name, parentFolderId, depth, isConfidential } });
  const general = await folder(dept.id, "General", null, 0);
  const sub = await folder(dept.id, "Sub", general.id, 1);
  const vault = await folder(dept.id, "Vault", null, 0, true);
  const vaultSub = await folder(dept.id, "VaultSub", vault.id, 1, true);
  const dept2Root = await folder(dept2.id, "General", null, 0);
  await prisma.confidentialMember.createMany({
    data: [
      { folderId: vault.id, userId: users.staff.id, isOwner: true },
      { folderId: vault.id, userId: users.vaultAdmin.id, isOwner: false },
      { folderId: vault.id, userId: users.restorer.id, isOwner: false },
    ],
  });

  return {
    org: { id: org.id, name: org.name },
    owner: { id: owner.id },
    superAdmin: { userId: owner.id, organizationId: org.id, isSuperAdmin: true },
    dept: { id: dept.id },
    dept2: { id: dept2.id },
    docType: {
      id: docTypeRow.id,
      titleFieldId: docTypeRow.fields.find((f) => f.isTitle)!.id,
      categoryFieldId: docTypeRow.fields.find((f) => f.label === "Category")!.id,
    },
    docType2: { id: docType2Row.id, titleFieldId: docType2Row.fields[0]!.id },
    docType3: { id: docType3Row.id, titleFieldId: docType3Row.fields[0]!.id },
    roles: {
      admin: adminRole.id,
      staff: staffRole.id,
      auditor: auditorRole.id,
      viewer: viewerRole.id,
      staffRestore: staffRestoreRole.id,
      admin2: admin2Role.id,
    },
    users,
    folders: { general: general.id, sub: sub.id, vault: vault.id, vaultSub: vaultSub.id, dept2Root: dept2Root.id },
    storageDir,
  };
}

/**
 * A document created directly with a chosen Upload Date (and that many versions, all dated then), in
 * the same shape `createDocument` produces. `uploadedAt` can only be set on insert — that is the rule.
 */
export async function makeDoc(
  prisma: PrismaClient,
  world: World,
  opts: {
    uploadedAt: Date;
    folderId?: string;
    departmentId?: string;
    documentTypeId?: string;
    titleFieldId?: string;
    title?: string;
    category?: string;
    versions?: number;
    organizationId?: string;
  },
) {
  const n = ++docCounter;
  const organizationId = opts.organizationId ?? world.org.id;
  const departmentId = opts.departmentId ?? world.dept.id;
  const documentTypeId = opts.documentTypeId ?? world.docType.id;
  const title = opts.title ?? `Doc ${n}`;
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        organizationId,
        departmentId,
        folderId: opts.folderId ?? world.folders.general,
        documentTypeId,
        documentRef: `ZZ-${stamp}-${n}`,
        titleValue: title,
        status: "active",
        uploadedAt: opts.uploadedAt,
        createdAt: opts.uploadedAt,
      },
    });
    let currentId = "";
    for (let v = 1; v <= (opts.versions ?? 1); v++) {
      const version = await tx.version.create({
        data: {
          organizationId,
          documentId: doc.id,
          versionNumber: v,
          storageRef: `zz/${stamp}/${n}/v${v}`,
          fileName: `doc-${n}-v${v}.pdf`,
          fileSize: 10,
          mimeType: "application/pdf",
          uploadedByUserId: world.users.staff.id,
          createdAt: opts.uploadedAt,
        },
      });
      currentId = version.id;
    }
    await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: currentId } });
    await tx.fieldValue.create({ data: { documentId: doc.id, fieldDefId: opts.titleFieldId ?? world.docType.titleFieldId, value: title } });
    if (opts.category) {
      await tx.fieldValue.create({ data: { documentId: doc.id, fieldDefId: world.docType.categoryFieldId, value: opts.category } });
    }
    return doc;
  });
}

/** Removes every row a world created, in foreign-key order, and its scratch storage folder. */
export async function destroyWorld(prisma: PrismaClient, world: World | undefined) {
  if (!world) return;
  const orgId = world.org.id;
  const userIds = [world.owner.id, ...Object.values(world.users).map((u) => u.id)];
  try {
    // Test teardown only. The application has no path that deletes audit rows (AUD-3).
    await purgeTestAuditEvents(prisma, { where: { organizationId: orgId } });
    await prisma.legalHold.deleteMany({ where: { organizationId: orgId } });
    await prisma.share.deleteMany({ where: { organizationId: orgId } });
    await prisma.fieldValue.deleteMany({ where: { document: { organizationId: orgId } } });
    await prisma.document.updateMany({ where: { organizationId: orgId }, data: { currentVersionId: null } });
    await prisma.version.deleteMany({ where: { organizationId: orgId } });
    await prisma.document.deleteMany({ where: { organizationId: orgId } });
    await prisma.documentRefSequence.deleteMany({ where: { organizationId: orgId } });
    await prisma.confidentialMember.deleteMany({ where: { folder: { organizationId: orgId } } });
    await prisma.folderPermission.deleteMany({ where: { folder: { organizationId: orgId } } });
    await prisma.folder.updateMany({ where: { organizationId: orgId }, data: { parentFolderId: null } });
    await prisma.folder.deleteMany({ where: { organizationId: orgId } });
    await prisma.membership.deleteMany({ where: { organizationId: orgId } });
    await prisma.fieldDef.deleteMany({ where: { documentType: { department: { organizationId: orgId } } } });
    await prisma.documentType.deleteMany({ where: { department: { organizationId: orgId } } });
    await prisma.role.deleteMany({ where: { organizationId: orgId } });
    await prisma.department.deleteMany({ where: { organizationId: orgId } });
    await prisma.storageConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (err) {
    console.error("[cleanup] failed:", err);
  }
  rmSync(world.storageDir, { recursive: true, force: true });
}
