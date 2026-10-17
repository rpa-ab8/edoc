// The permission catalogue — the fixed set of boolean keys stored on `role.permissions`.
//
// Source of truth: Data Model §3 (the key list, verbatim) and Feature Spec §2A.4 (the grouping
// and display labels). The catalogue is deliberately fixed and code-side rather than a table:
// every role answers the same set of questions, so a join table would buy nothing (Data Model §3).
//
// Key format is `group.key`. Do not rename a key once roles exist in the database — the stored
// JSON maps are keyed by these exact strings.

export type PermissionKey = string;

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: { key: PermissionKey; label: string; inactiveInR1?: boolean }[];
}

export const PERMISSION_CATALOGUE: PermissionGroup[] = [
  {
    key: "documents",
    label: "Documents",
    permissions: [
      { key: "documents.view", label: "View documents" },
      { key: "documents.upload", label: "Upload documents" },
      { key: "documents.download", label: "Download documents" },
      { key: "documents.edit_metadata", label: "Edit metadata" },
      { key: "documents.delete", label: "Delete documents" },
      { key: "documents.restore", label: "Restore from trash" },
      { key: "documents.version_history", label: "View version history" },
      { key: "documents.preview", label: "Preview documents" },
      { key: "documents.upload_version", label: "Upload a new version" },
    ],
  },
  {
    key: "folders",
    label: "Folders",
    permissions: [
      { key: "folders.create", label: "Create folders" },
      { key: "folders.rename", label: "Rename folders" },
      { key: "folders.delete", label: "Delete folders" },
      { key: "folders.move", label: "Move folders" },
    ],
  },
  {
    key: "sharing",
    label: "Sharing",
    permissions: [
      { key: "sharing.share", label: "Share documents" },
      { key: "sharing.remove_share", label: "Remove a share" },
      { key: "sharing.create_link", label: "Create a link" },
      { key: "sharing.external_share", label: "External share" },
      { key: "sharing.cross_department_share", label: "Cross-department share" },
    ],
  },
  {
    // Workflow is Release 2 (CLAUDE.md "Current build phase"). The keys exist because the
    // catalogue is specified as fixed, but nothing in R1 reads them — they are surfaced in the
    // role editor as inactive rather than hidden, so a department's matrix doesn't silently
    // change shape when R2 turns them on.
    key: "workflow",
    label: "Workflow",
    permissions: [
      { key: "workflow.approve", label: "Approve", inactiveInR1: true },
      { key: "workflow.reject", label: "Reject", inactiveInR1: true },
      { key: "workflow.request_changes", label: "Request changes", inactiveInR1: true },
      { key: "workflow.create_workflow", label: "Create workflow", inactiveInR1: true },
    ],
  },
  {
    key: "search",
    label: "Search",
    permissions: [
      { key: "search.search", label: "Search" },
      { key: "search.advanced_search", label: "Advanced search" },
      { key: "search.saved_searches", label: "Saved searches", inactiveInR1: true },
    ],
  },
  {
    key: "audit",
    label: "Audit",
    permissions: [
      { key: "audit.view_audit", label: "View audit log" },
      { key: "audit.export_audit", label: "Export audit log" },
      { key: "audit.view_confidential_audit", label: "View confidential audit events" },
    ],
  },
  {
    key: "members",
    label: "Members",
    permissions: [
      { key: "members.invite", label: "Invite members" },
      { key: "members.remove", label: "Remove members" },
      { key: "members.change_role", label: "Change member roles" },
    ],
  },
  {
    key: "configuration",
    label: "Configuration",
    permissions: [
      { key: "configuration.create_document_type", label: "Create document type" },
      { key: "configuration.edit_document_type", label: "Edit document type" },
      { key: "configuration.delete_document_type", label: "Delete document type" },
      { key: "configuration.edit_metadata_schema", label: "Edit metadata schema" },
      { key: "configuration.edit_rules", label: "Edit rules" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    permissions: [
      { key: "reports.view_reports", label: "View reports", inactiveInR1: true },
      { key: "reports.export_reports", label: "Export reports", inactiveInR1: true },
    ],
  },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_CATALOGUE.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

const PERMISSION_KEY_SET = new Set(ALL_PERMISSION_KEYS);

// Feature Spec §2A.7 / Data Model §3: enabling a child auto-enables its parent, and an invalid
// combination must be refused rather than silently coerced at the API boundary.
//
// Two entries here are NOT literally in the docs and are flagged rather than assumed silently:
//  - `documents.restore` — the docs say "restore requires access to Trash", but the catalogue
//    has no trash key at all. Mapped to `documents.view` (the weakest defensible parent) until
//    Module 11 (Trash) settles whether a `documents.trash` key needs to exist.
//  - `audit.view_confidential_audit` — undocumented as a dependency, but a role that can see
//    confidential audit events while unable to see ordinary ones is incoherent.
export const PERMISSION_DEPENDENCIES: Record<PermissionKey, PermissionKey[]> = {
  "documents.download": ["documents.view"],
  "documents.edit_metadata": ["documents.view"],
  "documents.delete": ["documents.view"],
  "documents.preview": ["documents.view"],
  "documents.version_history": ["documents.view"],
  "documents.upload_version": ["documents.view"],
  "documents.restore": ["documents.view"],
  "sharing.remove_share": ["sharing.share"],
  "sharing.create_link": ["sharing.share"],
  "sharing.external_share": ["sharing.share"],
  "sharing.cross_department_share": ["sharing.share"],
  "audit.export_audit": ["audit.view_audit"],
  "audit.view_confidential_audit": ["audit.view_audit"],
  "workflow.approve": ["documents.view"],
  "workflow.reject": ["documents.view"],
  "workflow.request_changes": ["documents.view"],
};

// A role counts as Department-Admin-capable when it can both manage the department's members
// and edit its configuration.
//
// FLAGGED — the docs describe "Department Admin" as a capability level (Feature Spec §2A.2) and
// as an undeletable system role (§2A.8 rule 4), but never define which catalogue keys constitute
// it, and the example matrix in §2A.4 shows a "Create roles" row that has no corresponding key
// in the Data Model §3 catalogue at all. Rather than invent a key, capability is derived from
// the two keys below. If the catalogue ever gains an explicit role-management key, move this.
export const DEPARTMENT_ADMIN_CAPABILITY_KEYS: PermissionKey[] = [
  "members.change_role",
  "configuration.edit_rules",
];

export type PermissionMap = Record<PermissionKey, boolean>;

export function isKnownPermissionKey(key: string): boolean {
  return PERMISSION_KEY_SET.has(key);
}

/** Every catalogue key present, defaulting to false — the canonical stored shape. */
export function emptyPermissionMap(): PermissionMap {
  return Object.fromEntries(ALL_PERMISSION_KEYS.map((k) => [k, false]));
}

export function permissionMapFrom(granted: PermissionKey[]): PermissionMap {
  const map = emptyPermissionMap();
  for (const key of granted) {
    if (PERMISSION_KEY_SET.has(key)) map[key] = true;
  }
  return applyPermissionDependencies(map);
}

/**
 * Transitively enables the parents of every granted key (Feature Spec §2A.7). Idempotent, and
 * always returns a full map containing every catalogue key.
 */
export function applyPermissionDependencies(input: PermissionMap): PermissionMap {
  const map = emptyPermissionMap();
  for (const [key, value] of Object.entries(input)) {
    if (PERMISSION_KEY_SET.has(key)) map[key] = value === true;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parents] of Object.entries(PERMISSION_DEPENDENCIES)) {
      if (!map[child]) continue;
      for (const parent of parents) {
        if (!map[parent]) {
          map[parent] = true;
          changed = true;
        }
      }
    }
  }
  return map;
}

/** The keys whose parents are missing — an invalid combination the editor must refuse. */
export function findDependencyViolations(input: PermissionMap): { key: PermissionKey; requires: PermissionKey[] }[] {
  const violations: { key: PermissionKey; requires: PermissionKey[] }[] = [];
  for (const [child, parents] of Object.entries(PERMISSION_DEPENDENCIES)) {
    if (input[child] !== true) continue;
    const missing = parents.filter((p) => input[p] !== true);
    if (missing.length > 0) violations.push({ key: child, requires: missing });
  }
  return violations;
}

export function hasDepartmentAdminCapability(permissions: unknown): boolean {
  if (typeof permissions !== "object" || permissions === null) return false;
  const map = permissions as PermissionMap;
  return DEPARTMENT_ADMIN_CAPABILITY_KEYS.every((k) => map[k] === true);
}

export function grantsPermission(permissions: unknown, key: PermissionKey): boolean {
  if (typeof permissions !== "object" || permissions === null) return false;
  return (permissions as PermissionMap)[key] === true;
}
