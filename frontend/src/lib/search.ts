import { apiRequest } from "./api";

export type QuickView = "recent" | "uploaded_by_me" | "shared_with_me" | "shared_by_me" | "trash";

/** The share-backed quick views don't hit the department search endpoint — they draw from the
 *  sharing API and span the whole organization (bug 2). */
export const SHARE_QUICK_VIEWS: QuickView[] = ["shared_with_me", "shared_by_me"];

export type FilterOp = "contains" | "exact" | "in" | "date_range" | "number_range";

export interface SearchFilter {
  fieldDefId: string;
  op: FilterOp;
  value?: string;
  values?: string[];
  from?: string;
  to?: string;
}

export interface SearchParams {
  q?: string;
  documentTypeId?: string;
  quickView?: QuickView;
  filters?: SearchFilter[];
  /** Standard Upload Date filter (SRCH-6): YYYY-MM-DD, inclusive, in the organization's time zone. */
  uploadedFrom?: string;
  uploadedTo?: string;
  limit?: number;
}

/** The client-side twin of the server's check, so the panel can say so before searching. */
export function uploadDateRangeError(from: string, to: string): string | null {
  return from && to && from > to ? 'The Upload Date "From" can\'t be after "To".' : null;
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
  uploadedAt: string;
  updatedAt: string;
  legalHold: boolean;
}

export const searchDocuments = (departmentId: string, params: SearchParams) =>
  apiRequest<{ results: SearchResult[] }>(`/departments/${departmentId}/search`, {
    method: "POST",
    body: JSON.stringify(params),
  }).then((r) => r.results);
