import { Prisma, type PrismaClient } from "@prisma/client";
import {
  unviewableFolderIdsToExclude,
  type PermissionActor,
} from "../../lib/effective-permissions.js";

interface Deps {
  prisma: PrismaClient;
}

export type QuickView = "recent" | "uploaded_by_me" | "shared_with_me" | "trash";

export type FilterOp = "contains" | "exact" | "in" | "date_range" | "number_range";

export interface SearchFilter {
  fieldDefId: string;
  op: FilterOp;
  value?: string; // contains / exact
  values?: string[]; // in (dropdown multi-select)
  from?: string; // range lower bound (ISO date, or number as string)
  to?: string; // range upper bound
}

export interface SearchParams {
  departmentId: string;
  q?: string;
  documentTypeId?: string;
  quickView?: QuickView;
  filters?: SearchFilter[];
  limit?: number;
}

export interface SearchResult {
  id: string;
  documentRef: string;
  titleValue: string | null;
  documentType: string;
  folderId: string;
  folderName: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  updatedAt: Date;
}

/**
 * Turns a search-as-you-type string into a prefix tsquery: each alphanumeric term becomes `term:*`
 * and they are ANDed. Sanitising to alphanumerics keeps `to_tsquery` from choking on user input and
 * removes any injection surface, while the prefix (`:*`) is what makes "inv" match "invoice" before
 * the word is finished. Returns null when the query has no usable terms.
 */
function buildPrefixTsquery(q: string): string | null {
  // Split on any run of non-alphanumerics (whitespace, hyphens, etc.), so a hyphenated query
  // becomes several ANDed prefix terms rather than one concatenated token.
  const terms = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(" & ");
}

/** A single field-value condition (used inside an EXISTS on `field_value`), or null if unusable. */
function fieldValueCondition(filter: SearchFilter): Prisma.Sql | null {
  switch (filter.op) {
    case "contains": {
      if (!filter.value) return null;
      return Prisma.sql`fv."value" ILIKE ${"%" + filter.value + "%"}`;
    }
    case "exact": {
      if (!filter.value) return null;
      return Prisma.sql`fv."value" = ${filter.value}`;
    }
    case "in": {
      if (!filter.values || filter.values.length === 0) return null;
      return Prisma.sql`fv."value" IN (${Prisma.join(filter.values)})`;
    }
    case "date_range": {
      // Values are stored as ISO date strings (YYYY-MM-DD), which sort chronologically as text.
      const parts: Prisma.Sql[] = [];
      if (filter.from) parts.push(Prisma.sql`fv."value" >= ${filter.from}`);
      if (filter.to) parts.push(Prisma.sql`fv."value" <= ${filter.to}`);
      return parts.length ? Prisma.join(parts, " AND ") : null;
    }
    case "number_range": {
      // Guard against non-numeric stored values before casting, so a stray text value can't error
      // the whole query.
      const parts: Prisma.Sql[] = [Prisma.sql`fv."value" ~ '^-?[0-9]+(\.[0-9]+)?$'`];
      if (filter.from !== undefined && filter.from !== "") parts.push(Prisma.sql`fv."value"::numeric >= ${Number(filter.from)}`);
      if (filter.to !== undefined && filter.to !== "") parts.push(Prisma.sql`fv."value"::numeric <= ${Number(filter.to)}`);
      return parts.length > 1 ? Prisma.join(parts, " AND ") : null;
    }
    default:
      return null;
  }
}

/**
 * Department-scoped document search (SRCH-1..5). Text query hits the `search_vector` (filename +
 * field values + OCR text + ID/title); filters stack as EXISTS conditions on `field_value`, one per
 * field type; results ignore folder depth. Confidential folders the actor isn't named on are
 * excluded at the query layer — a CLAUDE.md hard rule (SRCH-5) — and the route additionally gates
 * `search.search`. Default order is most-recent-first (SRCH-3); a text query orders by relevance.
 */
export async function searchDocuments(
  deps: Deps,
  actor: PermissionActor,
  params: SearchParams,
): Promise<SearchResult[]> {
  const { prisma } = deps;

  // Sharing (Module 9) and Trash (Module 11) don't exist yet — their quick views are honest empties.
  if (params.quickView === "shared_with_me" || params.quickView === "trash") return [];

  // Confidential vaults *and* folders an override withholds `documents.view` on — a result the
  // caller would be refused on click must not be listed in the first place (SRCH-5 and FLD-3).
  const hidden = await unviewableFolderIdsToExclude(prisma, actor, params.departmentId);

  const conditions: Prisma.Sql[] = [
    Prisma.sql`d."organizationId" = ${actor.organizationId}`,
    Prisma.sql`d."departmentId" = ${params.departmentId}`,
    Prisma.sql`d."status" = 'active'`,
  ];
  if (hidden.length > 0) {
    conditions.push(Prisma.sql`d."folderId" NOT IN (${Prisma.join(hidden)})`);
  }
  if (params.documentTypeId) {
    conditions.push(Prisma.sql`d."documentTypeId" = ${params.documentTypeId}`);
  }
  if (params.quickView === "uploaded_by_me") {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "version" v WHERE v."documentId" = d.id AND v."uploadedByUserId" = ${actor.userId})`,
    );
  }

  // Text query: the tsvector handles words (title, field values, filename, OCR body), while a
  // direct ILIKE on the document ID makes structured identifiers searchable whole or in part —
  // Postgres tokenises "ACC-INV-2026-00001" into pieces like `acc-inv` and `-00001`, so a tsquery
  // alone can't reliably match a pasted ID (DOC-3 / SRCH-1).
  const query = params.q?.trim();
  const tsquery = query ? buildPrefixTsquery(query) : null;
  if (query) {
    const idLike = `%${query}%`;
    conditions.push(
      tsquery
        ? Prisma.sql`(d."searchVector" @@ to_tsquery('english', ${tsquery}) OR d."documentRef" ILIKE ${idLike})`
        : Prisma.sql`d."documentRef" ILIKE ${idLike}`,
    );
  }

  for (const filter of params.filters ?? []) {
    const inner = fieldValueCondition(filter);
    if (!inner) continue;
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "field_value" fv WHERE fv."documentId" = d.id AND fv."fieldDefId" = ${filter.fieldDefId} AND ${inner})`,
    );
  }

  const where = Prisma.join(conditions, " AND ");
  const orderBy = tsquery
    ? Prisma.sql`ts_rank(d."searchVector", to_tsquery('english', ${tsquery})) DESC, d."updatedAt" DESC`
    : Prisma.sql`d."updatedAt" DESC`;
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);

  const rows = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT d.id FROM "document" d WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit}`,
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  // Fetch display data through the typed client, then restore the ranked order.
  const docs = await prisma.document.findMany({
    where: { id: { in: ids } },
    include: {
      documentType: { select: { name: true } },
      folder: { select: { name: true } },
      currentVersion: { select: { fileName: true, fileSize: true, mimeType: true } },
    },
  });
  const byId = new Map(docs.map((d) => [d.id, d]));

  return ids
    .map((id) => byId.get(id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({
      id: d.id,
      documentRef: d.documentRef,
      titleValue: d.titleValue,
      documentType: d.documentType.name,
      folderId: d.folderId,
      folderName: d.folder?.name ?? null,
      fileName: d.currentVersion?.fileName ?? null,
      fileSize: d.currentVersion?.fileSize ?? null,
      mimeType: d.currentVersion?.mimeType ?? null,
      updatedAt: d.updatedAt,
    }));
}
