import type { Prisma } from "@prisma/client";

/**
 * The document-ID generator — `DEPT-TYPE-YYYY-NNNNN` (e.g. "HR-CON-2026-00142").
 *
 * Feature Spec §6A.1 / Data Model §4.3–4.4:
 *  - The department prefix and the type's id_code form the DEPT-TYPE segment.
 *  - The number is drawn from `document_ref_sequence`, keyed per organization/department/type/year,
 *    so numbering never collides across those boundaries.
 *  - The ID is immutable, never reused, and shared across every version (a CLAUDE.md hard rule).
 *
 * Must run inside a transaction: the caller creates the document in the same `$transaction` that
 * reserves the number, so a rolled-back document creation never burns a sequence value that then
 * shows up as a gap. The row-level upsert makes the increment atomic; under a genuine create race
 * two transactions can collide on the sequence row and one rolls back — acceptable at R1's volume,
 * and the `@@unique([organizationId, documentRef])` backstop guarantees no duplicate ever persists.
 */
export async function generateDocumentRef(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    departmentId: string;
    documentTypeId: string;
    idPrefix: string;
    idCode: string;
    year: number;
  },
): Promise<string> {
  const seq = await tx.documentRefSequence.upsert({
    where: {
      organizationId_departmentId_documentTypeId_year: {
        organizationId: input.organizationId,
        departmentId: input.departmentId,
        documentTypeId: input.documentTypeId,
        year: input.year,
      },
    },
    create: {
      organizationId: input.organizationId,
      departmentId: input.departmentId,
      documentTypeId: input.documentTypeId,
      year: input.year,
      lastNumber: 1,
    },
    update: { lastNumber: { increment: 1 } },
  });

  // At least five digits; a department that somehow issues more than 99,999 of one type in a year
  // simply gets a longer number rather than a wrapped or truncated one.
  const number = String(seq.lastNumber).padStart(5, "0");
  return `${input.idPrefix}-${input.idCode}-${input.year}-${number}`;
}
