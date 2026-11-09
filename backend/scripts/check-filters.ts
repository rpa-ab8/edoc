/**
 * Standard filter checks — `npm run check:filters` (backend workspace). PRD v1.2 SRCH-6.
 *
 * Every department's filter panel always offers Document Type and Upload Date (From – To), with no
 * admin setup. Both Upload Date bounds are inclusive whole days on the *organization's* calendar, and
 * the standard filters AND with each other, with schema field filters and with the search text —
 * and never return a document the user can't access (SRCH-5).
 *
 * Builds a throwaway organization (never the real "Abate" org).
 *
 * DEV ONLY. Point it at a development database.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ path: "C:/apps/DMS/.env" });

import { loadEnv } from "../src/config/env.js";
import * as search from "../src/modules/search/search.service.js";
import { refreshDocumentSearchVector } from "../src/lib/search-vector.js";
import { permissionMapFrom } from "../src/lib/permissions.js";
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
const deps = { prisma };
let world: World | undefined;

try {
  world = await buildWorld(prisma, env, "flt");
  const w = world;
  // The searcher is a read-only Viewer: not on the vault's named list (Staff is the vault's Owner in
  // these fixtures), and the role a folder restriction is applied to below.
  const { viewer: searcher, vaultAdmin } = w.users;

  // Upload instants chosen around midnight India time, where the UTC date and the local date differ.
  const mk = async (uploadedAt: Date, title: string, extra: Partial<Parameters<typeof makeDoc>[2]> = {}) => {
    const doc = await makeDoc(prisma, w, { uploadedAt, title, ...extra });
    await refreshDocumentSearchVector(prisma, doc.id);
    return doc;
  };
  const d1 = await mk(ist("2026-03-01T00:10:00"), "Alpha invoice", { category: "Red" }); // UTC 28 Feb
  const d2 = await mk(ist("2026-03-05T23:50:00"), "Bravo invoice", { category: "Blue" });
  const d3 = await mk(ist("2026-03-06T00:05:00"), "Charlie contract", { documentTypeId: w.docType2.id, titleFieldId: w.docType2.titleFieldId }); // UTC 5 Mar
  const d4 = await mk(ist("2026-04-10T12:00:00"), "Delta invoice", { category: "Red" });
  const d5 = await mk(ist("2026-03-03T12:00:00"), "Echo contract", { documentTypeId: w.docType2.id, titleFieldId: w.docType2.titleFieldId });
  const vaultDoc = await mk(ist("2026-03-03T12:00:00"), "Foxtrot invoice", { folderId: w.folders.vault, category: "Red" });
  const restricted = await mk(ist("2026-03-03T12:00:00"), "Golf invoice", { folderId: w.folders.sub, category: "Red" });

  const ids = async (params: Omit<search.SearchParams, "departmentId">, actor = searcher.actor) =>
    new Set((await search.searchDocuments(deps, actor, { departmentId: w.dept.id, ...params })).map((r) => r.id));
  const same = (got: Set<string>, want: string[]) =>
    got.size === want.length && want.every((id) => got.has(id));
  const show = (got: Set<string>) => [...got].map((id) => [d1, d2, d3, d4, d5, vaultDoc, restricted].findIndex((d) => d.id === id) + 1).join(",");

  // A folder override that withholds viewing from the Viewer role (FLD-3) — its documents must not be listed.
  await prisma.folderPermission.create({
    data: { folderId: w.folders.sub, roleId: w.roles.viewer, permissions: permissionMapFrom(["search.search"]) as object },
  });

  section("Document Type alone");
  let got = await ids({ documentTypeId: w.docType2.id });
  check("returns only that type", same(got, [d3.id, d5.id]), show(got));

  section("Upload Date alone (inclusive, organization time zone)");
  got = await ids({ uploadedFrom: "2026-03-06" });
  check("From only", same(got, [d3.id, d4.id]), show(got));
  got = await ids({ uploadedTo: "2026-03-05" });
  check("To only — includes the whole of the To day", same(got, [d1.id, d2.id, d5.id]), show(got));
  got = await ids({ uploadedFrom: "2026-03-01", uploadedTo: "2026-03-05" });
  check("both — includes both boundary days", same(got, [d1.id, d2.id, d5.id]), show(got));
  got = await ids({ uploadedFrom: "2026-03-06", uploadedTo: "2026-03-06" });
  check("a single day (From = To)", same(got, [d3.id]), show(got));
  got = await ids({ uploadedFrom: "2026-03-02", uploadedTo: "2026-03-04" });
  check("a 00:10 upload on 1 Mar (still 28 Feb in UTC) falls on 1 Mar", !got.has(d1.id) && same(got, [d5.id]), show(got));

  section("standard filters combined");
  got = await ids({ documentTypeId: w.docType.id, uploadedFrom: "2026-03-01", uploadedTo: "2026-03-31" });
  check("Document Type AND Upload Date", same(got, [d1.id, d2.id]), show(got));
  got = await ids({ q: "invoice", uploadedFrom: "2026-03-01", uploadedTo: "2026-03-31" });
  check("with search text", same(got, [d1.id, d2.id]), show(got));
  got = await ids({
    documentTypeId: w.docType.id,
    uploadedFrom: "2026-03-01",
    filters: [{ fieldDefId: w.docType.categoryFieldId, op: "in", values: ["Red"] }],
  });
  check("with a schema field filter", same(got, [d1.id, d4.id]), show(got));
  got = await ids({
    q: "alpha",
    documentTypeId: w.docType.id,
    uploadedTo: "2026-03-05",
    filters: [{ fieldDefId: w.docType.categoryFieldId, op: "in", values: ["Red"] }],
  });
  check("all of them together", same(got, [d1.id]), show(got));

  section("validation");
  await expectCode("From after To is refused", "invalid_date_range", () =>
    search.searchDocuments(deps, searcher.actor, { departmentId: w.dept.id, uploadedFrom: "2026-03-10", uploadedTo: "2026-03-01" }),
  );
  try {
    await search.searchDocuments(deps, searcher.actor, { departmentId: w.dept.id, uploadedFrom: "2026-03-10", uploadedTo: "2026-03-01" });
  } catch (err) {
    check("…with a clear message", (err as Error).message === 'The Upload Date "From" can\'t be after "To".', (err as Error).message);
  }
  await expectCode("a date that doesn't exist is refused", "invalid_date", () =>
    search.searchDocuments(deps, searcher.actor, { departmentId: w.dept.id, uploadedFrom: "2026-02-30" }),
  );

  section("never returns what the user can't access");
  got = await ids({ uploadedFrom: "2026-03-01", uploadedTo: "2026-03-31" });
  check("a confidential document is hidden from a non-member", !got.has(vaultDoc.id));
  check("a document in a folder the user's role is restricted out of is hidden", !got.has(restricted.id));
  const memberGot = await ids({ uploadedFrom: "2026-03-01", uploadedTo: "2026-03-31" }, vaultAdmin.actor);
  check("the vault's member does see the confidential one", memberGot.has(vaultDoc.id));
  const otherOrg = await search.searchDocuments(deps, { ...searcher.actor, organizationId: "00000000-0000-0000-0000-000000000000" }, {
    departmentId: w.dept.id,
    uploadedFrom: "2000-01-01",
  });
  check("another organization's actor gets nothing from this department", otherOrg.length === 0);

  section("the organization's time zone decides the day");
  await prisma.organization.update({ where: { id: w.org.id }, data: { timeZone: "UTC" } });
  got = await ids({ uploadedFrom: "2026-03-06", uploadedTo: "2026-03-06" });
  check("in UTC, the 00:05 IST upload on 6 Mar belongs to 5 Mar", !got.has(d3.id));
  got = await ids({ uploadedFrom: "2026-03-05", uploadedTo: "2026-03-05" });
  check("…so 5 Mar now holds both late uploads", same(got, [d2.id, d3.id]), show(got));
} catch (err) {
  console.error("TEST ERROR:", err);
  check("suite ran to completion", false, String(err));
} finally {
  await destroyWorld(prisma, world);
  console.log(`\n${summary()}`);
  await prisma.$disconnect();
  process.exit(failures() === 0 ? 0 : 1);
}
