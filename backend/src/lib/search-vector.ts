import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// The weighted vector expression, shared by the single-document refresh and the full backfill.
// A = the identifier and title (what people search by name), B = field values + filename,
// C = OCR body text. Column names are the Prisma camelCase columns (unquoted mapping isn't used
// on this project), so they are quoted verbatim.
const VECTOR_EXPR = Prisma.sql`
  setweight(to_tsvector('english', coalesce(d."documentRef", '')), 'A') ||
  setweight(to_tsvector('english', coalesce(d."titleValue", '')), 'A') ||
  setweight(to_tsvector('english', coalesce(
    (SELECT string_agg(fv."value", ' ') FROM "field_value" fv WHERE fv."documentId" = d.id), '')), 'B') ||
  setweight(to_tsvector('english', coalesce(
    (SELECT v."fileName" FROM "version" v WHERE v.id = d."currentVersionId"), '')), 'B') ||
  setweight(to_tsvector('english', coalesce(
    (SELECT v."ocrText" FROM "version" v WHERE v.id = d."currentVersionId"), '')), 'C')
`;

/**
 * Recomputes one document's `search_vector` from its own identity/title, its field values, and its
 * current version's filename and OCR text (Data Model §4.3). Called after every create, metadata
 * edit, new version, and OCR completion, so search never drifts from what the document actually is.
 * Safe to call with a transaction client (e.g. from inside the create transaction) or the base client.
 */
export async function refreshDocumentSearchVector(db: Db, documentId: string): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`UPDATE "document" AS d SET "searchVector" = ${VECTOR_EXPR} WHERE d.id = ${documentId}`,
  );
}

/** One-time backfill for documents that pre-date the column (run after the migration). */
export async function refreshAllDocumentSearchVectors(db: Db): Promise<number> {
  return db.$executeRaw(Prisma.sql`UPDATE "document" AS d SET "searchVector" = ${VECTOR_EXPR}`);
}
