import { apiRequest } from "./api";

export type FieldType = "text" | "id" | "dropdown" | "date" | "number" | "person";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  id: "ID",
  dropdown: "Dropdown",
  date: "Date",
  number: "Number",
  person: "Person",
};

// What each field type becomes downstream — shown in the schema builder so the admin can see
// that one definition drives the upload control and the filter control at once (Feature Spec
// §3 Step 3, "define once, works everywhere").
export const FIELD_TYPE_HINTS: Record<FieldType, string> = {
  text: "Free text · filters by contains",
  id: "Reference code · filters by exact match",
  dropdown: "Fixed choices · filters by multi-select",
  date: "Date picker · filters by range",
  number: "Numeric · filters by range",
  person: "A person · filters by picker",
};

export interface DraftField {
  id?: string;
  label: string;
  fieldType: FieldType;
  isRequired: boolean;
  isFilterable: boolean;
  isTitle: boolean;
  options?: string[];
}

export interface DraftDocumentType {
  id?: string;
  name: string;
  idCode: string;
  fields: DraftField[];
}

export type PermissionMap = Record<string, boolean>;

export interface DraftRole {
  id?: string;
  name: string;
  isSystem: boolean;
  permissions: PermissionMap;
  isDepartmentAdmin?: boolean;
}

export interface DepartmentRules {
  defaultSharing: {
    externalLinksEnabled: boolean;
    linkExpiryDays: number;
  };
}

export const DEFAULT_DEPARTMENT_RULES: DepartmentRules = {
  defaultSharing: { externalLinksEnabled: false, linkExpiryDays: 7 },
};

export interface DepartmentTemplate {
  key: string;
  name: string;
  description: string;
  suggestedName: string;
  suggestedIdPrefix: string;
  subjectTerm: string;
  identifierTerm: string;
  documentTypes: DraftDocumentType[];
  roles: DraftRole[];
  rules: DepartmentRules;
}

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: { key: string; label: string; inactiveInR1?: boolean }[];
}

export interface DepartmentSummary {
  id: string;
  name: string;
  idPrefix: string;
  subjectTerm: string | null;
  identifierTerm: string | null;
  subfolderDepthLimit: number | null;
  rules: DepartmentRules;
  status: "active" | "archived";
  documentTypeCount: number;
  memberCount: number;
  documentCount: number;
  createdAt: string;
}

export interface DepartmentMember {
  userId: string;
  email: string;
  fullName: string;
  roleId: string;
  roleName: string;
  status: string;
}

export interface DepartmentDetail {
  id: string;
  name: string;
  idPrefix: string;
  subjectTerm: string | null;
  identifierTerm: string | null;
  subfolderDepthLimit: number | null;
  rules: DepartmentRules;
  /** Auto-delete period in years (RET-1); null = off. Read-only here — set on the Retention tab. */
  autoDeleteYears: number | null;
  status: "active" | "archived";
  createdAt: string;
  documentTypes: (DraftDocumentType & { id: string })[];
  roles: (DraftRole & { id: string; isDepartmentAdmin: boolean })[];
  members: DepartmentMember[];
}

export const fetchTemplates = () =>
  apiRequest<{ templates: DepartmentTemplate[] }>("/departments/templates").then((r) => r.templates);

export const fetchPermissionCatalogue = () =>
  apiRequest<{ groups: PermissionGroup[]; dependencies: Record<string, string[]> }>(
    "/departments/permission-catalogue",
  );

export const fetchDepartments = () =>
  apiRequest<{ departments: DepartmentSummary[] }>("/departments").then((r) => r.departments);

export const fetchDepartment = (id: string) =>
  apiRequest<{ department: DepartmentDetail }>(`/departments/${id}`).then((r) => r.department);

export interface AddableMember {
  userId: string;
  email: string;
  fullName: string;
}

/** Org users who can be given a role in this department (excludes existing members and the Super Admin). */
export const fetchAddableMembers = (departmentId: string) =>
  apiRequest<{ members: AddableMember[] }>(`/departments/${departmentId}/addable-members`).then(
    (r) => r.members,
  );

/**
 * Ticking a child permission auto-enables its parent (Feature Spec §2A.7). This is the *client*
 * affordance only — the server independently refuses an invalid combination rather than
 * repairing it, so a hand-crafted request can't slip past this.
 */
export function withDependencies(
  permissions: PermissionMap,
  dependencies: Record<string, string[]>,
): PermissionMap {
  const next = { ...permissions };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parents] of Object.entries(dependencies)) {
      if (!next[child]) continue;
      for (const parent of parents) {
        if (!next[parent]) {
          next[parent] = true;
          changed = true;
        }
      }
    }
  }
  return next;
}

/** Turning a parent off must also turn off everything that depends on it. */
export function withDependentsCleared(
  permissions: PermissionMap,
  dependencies: Record<string, string[]>,
  turnedOff: string,
): PermissionMap {
  const next = { ...permissions, [turnedOff]: false };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parents] of Object.entries(dependencies)) {
      if (next[child] && parents.some((p) => !next[p])) {
        next[child] = false;
        changed = true;
      }
    }
  }
  return next;
}
