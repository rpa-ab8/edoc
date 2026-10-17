import { z } from "zod";
import { ALL_PERMISSION_KEYS } from "../../lib/permissions.js";

const fieldTypeSchema = z.enum(["text", "id", "dropdown", "date", "number", "person"]);

// The ID prefix is the DEPT segment of the document ID (DEP-4 / Feature Spec §6A.1's
// `DEPT-TYPE-YYYY-NNNNN`), so it is constrained to what is safe inside an identifier: uppercase
// letters and digits only, no separators that would make the ID ambiguous to split.
export const idPrefixSchema = z
  .string()
  .trim()
  .min(2)
  .max(8)
  .regex(/^[A-Z0-9]+$/, "Use uppercase letters and digits only (e.g. HR, MED, ACC).");

export const idCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(8)
  .regex(/^[A-Z0-9]+$/, "Use uppercase letters and digits only (e.g. CON, INV).");

export const fieldDefSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(80),
  fieldType: fieldTypeSchema,
  isRequired: z.boolean().default(false),
  isFilterable: z.boolean().default(true),
  isTitle: z.boolean().default(false),
  // Only meaningful for `dropdown`; validated against the field type in the service.
  options: z.array(z.string().trim().min(1)).optional(),
});

export const documentTypeSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  idCode: idCodeSchema,
  // Array order IS the sort order (DEP-2's "order" property) — the client reorders by moving
  // array elements, so there is no separate sortOrder field to keep in sync.
  fields: z.array(fieldDefSchema).min(1),
});

const permissionMapSchema = z.record(z.string(), z.boolean()).refine(
  (map) => Object.keys(map).every((k) => ALL_PERMISSION_KEYS.includes(k)),
  { message: "Unknown permission key" },
);

export const roleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  isSystem: z.boolean().default(false),
  permissions: permissionMapSchema,
});

// Step-5 rules (Feature Spec §3 Step 5), stored as JSON on `department.rules` — see Data Model
// §2.4. Only the half that has somewhere to land is modelled: auto-tagging is absent because a tag
// label has no column on `document` and folder-conditioned rules need folders to point at. When
// either lands it becomes another key here, not a schema change.
//
// Retention, expiry reminders and workflow are Release 2 and deliberately have no representation
// at all — a stored-but-ignored setting is worse than an absent one.
export const departmentRulesSchema = z.object({
  defaultSharing: z.object({
    // The safe baseline: external links off unless deliberately enabled.
    externalLinksEnabled: z.boolean(),
    // Any external link auto-expires; this is the default lifetime offered when one is created.
    linkExpiryDays: z.number().int().positive().max(365),
  }),
});

export type DepartmentRules = z.infer<typeof departmentRulesSchema>;

export const DEFAULT_DEPARTMENT_RULES: DepartmentRules = {
  defaultSharing: { externalLinksEnabled: false, linkExpiryDays: 7 },
};

export const createDepartmentSchema = z.object({
  templateKey: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
  idPrefix: idPrefixSchema,
  subjectTerm: z.string().trim().min(1).max(40),
  identifierTerm: z.string().trim().min(1).max(40),
  subfolderDepthLimit: z.number().int().positive().max(20).nullable().optional(),
  rules: departmentRulesSchema.optional(),
  documentTypes: z.array(documentTypeSchema).min(1),
  roles: z.array(roleSchema).min(1),
  // Members are drawn from the organization's existing directory (Feature Spec §3 Step 4) —
  // never created here. Roles have no id until the department is created, so they are referenced
  // by name within this payload.
  members: z
    .array(z.object({ userId: z.string().uuid(), roleName: z.string().trim().min(1) }))
    .default([]),
});

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  idPrefix: idPrefixSchema.optional(),
  subjectTerm: z.string().trim().min(1).max(40).optional(),
  identifierTerm: z.string().trim().min(1).max(40).optional(),
  subfolderDepthLimit: z.number().int().positive().max(20).nullable().optional(),
  rules: departmentRulesSchema.optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export const upsertDocumentTypeSchema = documentTypeSchema;

export const upsertRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  permissions: permissionMapSchema,
});

export const copyRoleSchema = z.object({ name: z.string().trim().min(1).max(60) });

export const addMemberSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
});

export const changeMemberRoleSchema = z.object({ roleId: z.string().uuid() });

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type UpsertDocumentTypeInput = z.infer<typeof upsertDocumentTypeSchema>;
export type UpsertRoleInput = z.infer<typeof upsertRoleSchema>;
