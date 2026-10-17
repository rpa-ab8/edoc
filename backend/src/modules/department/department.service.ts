import { Prisma, type PrismaClient } from "@prisma/client";
import { logAuditEvent } from "../../lib/audit.js";
import {
  applyPermissionDependencies,
  findDependencyViolations,
  hasDepartmentAdminCapability,
  type PermissionMap,
} from "../../lib/permissions.js";
import { canGrantRole, hasPermission } from "../../lib/effective-permissions.js";
import {
  DEPARTMENT_TEMPLATES,
  findTemplate,
  templateRolePermissions,
  type DepartmentTemplate,
} from "./department.templates.js";
import {
  DEFAULT_DEPARTMENT_RULES,
  type CreateDepartmentInput,
  type DepartmentRules,
  type UpdateDepartmentInput,
  type UpsertDocumentTypeInput,
  type UpsertRoleInput,
} from "./department.schemas.js";

export class DepartmentError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  prisma: PrismaClient;
}

export interface Actor {
  userId: string;
  organizationId: string;
  isSuperAdmin: boolean;
}

// ───────────────────────── Templates ─────────────────────────

export function listTemplates() {
  return DEPARTMENT_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    suggestedName: t.suggestedName,
    suggestedIdPrefix: t.suggestedIdPrefix,
    subjectTerm: t.subjectTerm,
    identifierTerm: t.identifierTerm,
    documentTypes: t.documentTypes.map((dt) => ({
      name: dt.name,
      idCode: dt.idCode,
      fields: dt.fields.map((f) => ({
        label: f.label,
        fieldType: f.fieldType,
        isRequired: f.isRequired ?? false,
        isFilterable: f.isFilterable ?? true,
        isTitle: f.isTitle ?? false,
        options: f.options,
      })),
    })),
    roles: t.roles.map((r) => ({
      name: r.name,
      isSystem: r.isSystem ?? false,
      permissions: templateRolePermissions(r),
    })),
    rules: t.rules,
  }));
}

// ───────────────────────── Access control ─────────────────────────

// Delegates to the single effective-permission engine (`lib/effective-permissions.ts`). Department
// configuration is folder-independent, so no folder is passed — but the engine, not this module,
// owns the resolution order. Do not reintroduce a local copy of that logic here.
export async function assertDepartmentPermission(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  permissionKey: string,
) {
  const department = await requireDepartment(deps, actor.organizationId, departmentId);

  const allowed = await hasPermission(deps.prisma, actor, departmentId, permissionKey);
  if (!allowed) {
    throw new DepartmentError(403, "forbidden", "Your role in this department does not allow this.");
  }
  return department;
}

async function requireDepartment(deps: Deps, organizationId: string, departmentId: string) {
  // Tenant isolation: departmentId alone is never trusted — it is always paired with the
  // organization from the caller's access token.
  const department = await deps.prisma.department.findFirst({
    where: { id: departmentId, organizationId },
  });
  if (!department) {
    throw new DepartmentError(404, "department_not_found", "Department not found.");
  }
  return department;
}

// ───────────────────────── Validation ─────────────────────────

function validateDocumentType(dt: UpsertDocumentTypeInput) {
  const titleFields = dt.fields.filter((f) => f.isTitle);
  if (titleFields.length !== 1) {
    throw new DepartmentError(
      400,
      "invalid_document_type",
      `"${dt.name}" must have exactly one title field — it is the headline shown in lists and search results.`,
    );
  }

  const labels = dt.fields.map((f) => f.label.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    throw new DepartmentError(400, "invalid_document_type", `"${dt.name}" has two fields with the same name.`);
  }

  for (const field of dt.fields) {
    if (field.fieldType === "dropdown") {
      if (!field.options || field.options.length === 0) {
        throw new DepartmentError(
          400,
          "invalid_document_type",
          `Dropdown field "${field.label}" needs at least one option.`,
        );
      }
      if (new Set(field.options).size !== field.options.length) {
        throw new DepartmentError(
          400,
          "invalid_document_type",
          `Dropdown field "${field.label}" has duplicate options.`,
        );
      }
    } else if (field.options && field.options.length > 0) {
      throw new DepartmentError(
        400,
        "invalid_document_type",
        `Only dropdown fields can carry options ("${field.label}" is a ${field.fieldType} field).`,
      );
    }
  }
}

function validateDocumentTypeSet(types: UpsertDocumentTypeInput[]) {
  types.forEach(validateDocumentType);

  const codes = types.map((t) => t.idCode.toUpperCase());
  if (new Set(codes).size !== codes.length) {
    throw new DepartmentError(
      400,
      "invalid_document_type",
      "Two document types share the same ID code — each code becomes the TYPE segment of a document ID, so they must be distinct.",
    );
  }
  const names = types.map((t) => t.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new DepartmentError(400, "invalid_document_type", "Two document types share the same name.");
  }
}

// Feature Spec §2A.7 is explicit that the editor "must refuse to save an invalid combination
// rather than silently coercing it" — so the API rejects rather than auto-fixing. The *client*
// auto-enables parents as cells are ticked; that is a UI affordance, not a server behaviour.
function validatePermissionMap(roleName: string, permissions: PermissionMap) {
  const violations = findDependencyViolations(permissions);
  const first = violations[0];
  if (first) {
    throw new DepartmentError(
      400,
      "invalid_permissions",
      `Role "${roleName}": "${first.key}" also requires ${first.requires.join(", ")}.`,
    );
  }
}

function validateRoleSet(roles: { name: string; permissions: PermissionMap }[]) {
  const names = roles.map((r) => r.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new DepartmentError(400, "invalid_role", "Two roles share the same name.");
  }
  for (const role of roles) validatePermissionMap(role.name, role.permissions);

  // Feature Spec §3 Step 4 / §2A.8 rule 4: a department must always retain at least one role
  // with Department-Admin capability, or it can be orphaned with nobody able to administer it.
  if (!roles.some((r) => hasDepartmentAdminCapability(r.permissions))) {
    throw new DepartmentError(
      400,
      "no_department_admin_role",
      "A department needs at least one role that can manage its members and configuration.",
    );
  }
}

async function assertIdPrefixAvailable(
  deps: Deps,
  organizationId: string,
  idPrefix: string,
  exceptDepartmentId?: string,
) {
  // Not a database constraint (the Data Model doesn't specify one), but document IDs are
  // `DEPT-TYPE-YYYY-NNNNN` — two departments sharing a prefix would make an ID ambiguous about
  // which department it came from, so it is enforced here at the application layer.
  const clash = await deps.prisma.department.findFirst({
    where: {
      organizationId,
      idPrefix,
      ...(exceptDepartmentId ? { id: { not: exceptDepartmentId } } : {}),
    },
  });
  if (clash) {
    throw new DepartmentError(
      409,
      "id_prefix_taken",
      `The prefix "${idPrefix}" is already used by the ${clash.name} department.`,
    );
  }
}

// ───────────────────────── Read ─────────────────────────

export async function listDepartments(deps: Deps, actor: Actor) {
  const { prisma } = deps;

  // A Super Admin sees every department; anyone else sees only the ones they hold a membership
  // in — a department they have no role in should not even be enumerable.
  const where: Prisma.DepartmentWhereInput = actor.isSuperAdmin
    ? { organizationId: actor.organizationId }
    : {
        organizationId: actor.organizationId,
        memberships: { some: { userId: actor.userId, status: "active" } },
      };

  const departments = await prisma.department.findMany({
    where,
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { documentTypes: true } },
    },
  });

  const summaries = await Promise.all(
    departments.map(async (d) => {
      const [memberCount, documentCount] = await Promise.all([
        prisma.membership.count({ where: { departmentId: d.id, status: "active" } }),
        prisma.document.count({ where: { departmentId: d.id, status: "active" } }),
      ]);
      return {
        id: d.id,
        name: d.name,
        idPrefix: d.idPrefix,
        subjectTerm: d.subjectTerm,
        identifierTerm: d.identifierTerm,
        subfolderDepthLimit: d.subfolderDepthLimit,
        rules: (d.rules as DepartmentRules | null) ?? DEFAULT_DEPARTMENT_RULES,
        status: d.status,
        documentTypeCount: d._count.documentTypes,
        memberCount,
        documentCount,
        createdAt: d.createdAt,
      };
    }),
  );

  return summaries;
}

// Reaching a department's settings is an administrative act, not a reading one: a Super Admin who
// is not a member must still be able to open it to add members and roles, while a plain member
// opens it to see the schema they work with. Either of those is enough.
export async function getDepartment(deps: Deps, actor: Actor, departmentId: string) {
  await requireDepartment(deps, actor.organizationId, departmentId);
  const canRead = await hasPermission(deps.prisma, actor, departmentId, "documents.view");
  const canAdminister = await hasPermission(deps.prisma, actor, departmentId, "members.change_role");
  if (!canRead && !canAdminister) {
    throw new DepartmentError(403, "forbidden", "You don't have access to this department.");
  }
  const { prisma } = deps;

  const department = await prisma.department.findFirstOrThrow({
    where: { id: departmentId, organizationId: actor.organizationId },
    include: {
      documentTypes: { include: { fields: { orderBy: { sortOrder: "asc" } } } },
      roles: { orderBy: { createdAt: "asc" } },
      memberships: { include: { user: true, role: true } },
    },
  });

  return {
    id: department.id,
    name: department.name,
    idPrefix: department.idPrefix,
    subjectTerm: department.subjectTerm,
    identifierTerm: department.identifierTerm,
    subfolderDepthLimit: department.subfolderDepthLimit,
    // Absent rules mean "the defaults" rather than "no rules" — resolve here so every caller
    // (and the UI) sees one consistent shape.
    rules: (department.rules as DepartmentRules | null) ?? DEFAULT_DEPARTMENT_RULES,
    status: department.status,
    createdAt: department.createdAt,
    documentTypes: department.documentTypes.map((dt) => ({
      id: dt.id,
      name: dt.name,
      idCode: dt.idCode,
      fields: dt.fields.map((f) => ({
        id: f.id,
        label: f.label,
        fieldType: f.fieldType,
        isRequired: f.isRequired,
        isFilterable: f.isFilterable,
        isTitle: f.isTitle,
        options: (f.options as string[] | null) ?? undefined,
        sortOrder: f.sortOrder,
      })),
    })),
    roles: department.roles.map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      permissions: r.permissions as PermissionMap,
      isDepartmentAdmin: hasDepartmentAdminCapability(r.permissions),
    })),
    members: department.memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      fullName: m.user.fullName,
      roleId: m.roleId,
      roleName: m.role.name,
      status: m.status,
    })),
  };
}

/**
 * Organization users who can be given a role in this department — anyone with an active membership
 * elsewhere in the org who isn't already a member here. Gated by `members.invite`, so a Department
 * Admin can populate the "add existing person" picker, not only a Super Admin.
 *
 * The Super Admin **cannot add themselves** (no self-service into a department they administer), but
 * a Department Admin **can** add the Super Admin if the org owner genuinely needs file access here.
 * So the Super Admin is a candidate for everyone *except* the Super Admin acting on their own list.
 * This is the user's rule (2026-07-24, refined) — grant is a deliberate act by someone else.
 */
export async function listAddableMembers(deps: Deps, actor: Actor, departmentId: string) {
  await assertDepartmentPermission(deps, actor, departmentId, "members.invite");
  const { prisma } = deps;

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.organizationId },
    select: { createdByUserId: true },
  });

  const memberships = await prisma.membership.findMany({
    where: { organizationId: actor.organizationId, status: "active" },
    select: {
      userId: true,
      departmentId: true,
      user: { select: { id: true, email: true, fullName: true } },
    },
  });

  const inThisDepartment = new Set(
    memberships.filter((m) => m.departmentId === departmentId).map((m) => m.userId),
  );

  // Candidates: everyone with an active membership somewhere in the org, plus the Super Admin
  // (org creator), who has no membership row of their own but can still be granted access here.
  const candidates = new Map<string, { userId: string; email: string; fullName: string }>();
  for (const m of memberships) {
    candidates.set(m.userId, { userId: m.user.id, email: m.user.email, fullName: m.user.fullName });
  }
  if (!candidates.has(org.createdByUserId)) {
    const superAdmin = await prisma.user.findUnique({
      where: { id: org.createdByUserId },
      select: { id: true, email: true, fullName: true },
    });
    if (superAdmin) {
      candidates.set(superAdmin.id, { userId: superAdmin.id, email: superAdmin.email, fullName: superAdmin.fullName });
    }
  }

  const addable: { userId: string; email: string; fullName: string }[] = [];
  for (const c of candidates.values()) {
    if (inThisDepartment.has(c.userId)) continue;
    // The Super Admin can't add *themselves*; a Department Admin adding them is fine.
    if (c.userId === org.createdByUserId && actor.isSuperAdmin) continue;
    addable.push(c);
  }
  return addable;
}

// ───────────────────────── Create ─────────────────────────

export async function createDepartment(deps: Deps, actor: Actor, input: CreateDepartmentInput) {
  const { prisma } = deps;

  const template: DepartmentTemplate | undefined = findTemplate(input.templateKey);
  if (!template) {
    throw new DepartmentError(400, "unknown_template", "That template does not exist.");
  }

  validateDocumentTypeSet(input.documentTypes);
  const roles = input.roles.map((r) => ({
    ...r,
    permissions: applyPermissionDependencies(r.permissions as PermissionMap),
  }));
  // Validate what the client actually sent, before dependency closure — otherwise an invalid
  // combination would be silently repaired by the line above instead of refused.
  validateRoleSet(input.roles.map((r) => ({ name: r.name, permissions: r.permissions as PermissionMap })));

  await assertIdPrefixAvailable(deps, actor.organizationId, input.idPrefix);

  const nameClash = await prisma.department.findFirst({
    where: { organizationId: actor.organizationId, name: input.name },
  });
  if (nameClash) {
    throw new DepartmentError(409, "department_name_taken", "A department with that name already exists.");
  }

  for (const member of input.members) {
    if (!roles.some((r) => r.name === member.roleName)) {
      throw new DepartmentError(400, "unknown_role", `No role named "${member.roleName}" in this department.`);
    }
  }
  await assertUsersAreInOrganization(
    deps,
    actor.organizationId,
    input.members.map((m) => m.userId),
  );

  const department = await prisma.$transaction(async (tx) => {
    const created = await tx.department.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name,
        idPrefix: input.idPrefix,
        subjectTerm: input.subjectTerm,
        identifierTerm: input.identifierTerm,
        subfolderDepthLimit: input.subfolderDepthLimit ?? null,
        rules: (input.rules ?? DEFAULT_DEPARTMENT_RULES) as unknown as Prisma.InputJsonValue,
      },
    });

    const roleIdByName = new Map<string, string>();
    for (const role of roles) {
      const createdRole = await tx.role.create({
        data: {
          organizationId: actor.organizationId,
          departmentId: created.id,
          name: role.name,
          isSystem: role.isSystem,
          permissions: role.permissions as Prisma.InputJsonValue,
        },
      });
      roleIdByName.set(role.name, createdRole.id);
    }

    for (const dt of input.documentTypes) {
      await tx.documentType.create({
        data: {
          departmentId: created.id,
          name: dt.name,
          idCode: dt.idCode.toUpperCase(),
          fields: {
            create: dt.fields.map((f, index) => ({
              label: f.label,
              fieldType: f.fieldType,
              isRequired: f.isRequired,
              isFilterable: f.isFilterable,
              isTitle: f.isTitle,
              options: f.fieldType === "dropdown" ? (f.options as Prisma.InputJsonValue) : undefined,
              sortOrder: index,
            })),
          },
        },
      });
    }

    // The creator is deliberately NOT auto-added as a member (user decision, 2026-07-23),
    // overriding Feature Spec §3 Step 4's "the creator is auto-assigned as the first Department
    // Admin". A Super Admin administers every department without belonging to one: they can add
    // members and roles from settings, but reading a department's documents requires a
    // membership like anyone else, so access always leaves a record behind. A new department can
    // therefore start with zero members — the at-least-one-admin guardrail is enforced on
    // *roles*, and on members only once members exist.
    for (const member of input.members) {
      await tx.membership.create({
        data: {
          organizationId: actor.organizationId,
          userId: member.userId,
          departmentId: created.id,
          roleId: roleIdByName.get(member.roleName)!,
          status: "active",
        },
      });
    }

    // Every department starts with a default "General" folder, so a member can upload the moment
    // they arrive — documents always need a folder, and this removes the "create a folder first"
    // step for anyone who just wants to drop files in and never organise into subfolders.
    await tx.folder.create({
      data: { organizationId: actor.organizationId, departmentId: created.id, name: "General", depth: 0 },
    });

    return created;
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId: department.id,
    targetDescription: `Department created: ${department.name} (template: ${template.key})`,
  });

  return getDepartment(deps, actor, department.id);
}

async function assertUsersAreInOrganization(deps: Deps, organizationId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const org = await deps.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

  for (const userId of new Set(userIds)) {
    if (userId === org.createdByUserId) continue;
    const existing = await deps.prisma.membership.findFirst({ where: { organizationId, userId } });
    if (!existing) {
      throw new DepartmentError(
        400,
        "not_an_organization_member",
        "Members are drawn from the organization's existing directory — invite the user to the organization first.",
      );
    }
  }
}

// ───────────────────────── Update ─────────────────────────

export async function updateDepartment(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  input: UpdateDepartmentInput,
) {
  const { prisma } = deps;
  const department = await requireDepartment(deps, actor.organizationId, departmentId);

  // Archiving/renaming a department is organization-level administration (Feature Spec §2A.1),
  // while vocabulary and depth are department configuration a Department Admin owns.
  if (input.status !== undefined || input.name !== undefined) {
    if (!actor.isSuperAdmin) {
      throw new DepartmentError(403, "forbidden", "Only the Super Admin can rename or archive a department.");
    }
  } else {
    await assertDepartmentPermission(deps, actor, departmentId, "configuration.edit_rules");
  }

  if (input.idPrefix && input.idPrefix !== department.idPrefix) {
    await assertIdPrefixAvailable(deps, actor.organizationId, input.idPrefix, departmentId);
  }

  const { rules, ...rest } = input;
  const updated = await prisma.department.update({
    where: { id: departmentId },
    data: { ...rest, ...(rules ? { rules: rules as unknown as Prisma.InputJsonValue } : {}) },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId,
    // DEP-4: changing the prefix never rewrites existing document IDs — they are immutable
    // (CLAUDE.md hard rule). Only IDs generated after this point use the new prefix.
    targetDescription: `Department updated: ${updated.name}`,
  });

  return getDepartment(deps, actor, departmentId);
}

// ───────────────────────── Document types ─────────────────────────

export async function createDocumentType(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  input: UpsertDocumentTypeInput,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "configuration.create_document_type");
  validateDocumentType(input);

  const existing = await prisma.documentType.findMany({ where: { departmentId } });
  if (existing.some((t) => t.idCode.toUpperCase() === input.idCode.toUpperCase())) {
    throw new DepartmentError(409, "id_code_taken", `The code "${input.idCode}" is already used in this department.`);
  }
  if (existing.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) {
    throw new DepartmentError(409, "document_type_name_taken", "A document type with that name already exists.");
  }

  const created = await prisma.documentType.create({
    data: {
      departmentId,
      name: input.name,
      idCode: input.idCode.toUpperCase(),
      fields: {
        create: input.fields.map((f, index) => ({
          label: f.label,
          fieldType: f.fieldType,
          isRequired: f.isRequired,
          isFilterable: f.isFilterable,
          isTitle: f.isTitle,
          options: f.fieldType === "dropdown" ? (f.options as Prisma.InputJsonValue) : undefined,
          sortOrder: index,
        })),
      },
    },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId,
    targetDescription: `Document type created: ${created.name}`,
  });

  return created;
}

export async function updateDocumentType(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  documentTypeId: string,
  input: UpsertDocumentTypeInput,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "configuration.edit_document_type");
  validateDocumentType(input);

  // document_type carries no organization_id of its own (Data Model §5.1) — it is reachable only
  // through its department, so isolation is enforced by pairing the two here.
  const existing = await prisma.documentType.findFirst({
    where: { id: documentTypeId, departmentId },
    include: { fields: true },
  });
  if (!existing) throw new DepartmentError(404, "document_type_not_found", "Document type not found.");

  const siblings = await prisma.documentType.findMany({
    where: { departmentId, id: { not: documentTypeId } },
  });
  if (siblings.some((t) => t.idCode.toUpperCase() === input.idCode.toUpperCase())) {
    throw new DepartmentError(409, "id_code_taken", `The code "${input.idCode}" is already used in this department.`);
  }

  const keptFieldIds = new Set(input.fields.map((f) => f.id).filter(Boolean) as string[]);
  const removedFields = existing.fields.filter((f) => !keptFieldIds.has(f.id));

  if (removedFields.length > 0) {
    // A field with values on real documents cannot simply vanish — that would orphan
    // `field_value` rows and silently drop metadata users entered.
    const valueCount = await prisma.fieldValue.count({
      where: { fieldDefId: { in: removedFields.map((f) => f.id) } },
    });
    if (valueCount > 0) {
      throw new DepartmentError(
        409,
        "field_in_use",
        "That field already holds values on existing documents and cannot be removed.",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.documentType.update({
      where: { id: documentTypeId },
      data: { name: input.name, idCode: input.idCode.toUpperCase() },
    });

    if (removedFields.length > 0) {
      await tx.fieldDef.deleteMany({ where: { id: { in: removedFields.map((f) => f.id) } } });
    }

    for (const [index, field] of input.fields.entries()) {
      const data = {
        label: field.label,
        fieldType: field.fieldType,
        isRequired: field.isRequired,
        isFilterable: field.isFilterable,
        isTitle: field.isTitle,
        options: field.fieldType === "dropdown" ? (field.options as Prisma.InputJsonValue) : Prisma.DbNull,
        sortOrder: index,
      };
      if (field.id && existing.fields.some((f) => f.id === field.id)) {
        await tx.fieldDef.update({ where: { id: field.id }, data });
      } else {
        await tx.fieldDef.create({ data: { ...data, documentTypeId } });
      }
    }
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId,
    targetDescription: `Document type updated: ${input.name}`,
  });

  return prisma.documentType.findFirstOrThrow({
    where: { id: documentTypeId },
    include: { fields: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function deleteDocumentType(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  documentTypeId: string,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "configuration.delete_document_type");

  const existing = await prisma.documentType.findFirst({ where: { id: documentTypeId, departmentId } });
  if (!existing) throw new DepartmentError(404, "document_type_not_found", "Document type not found.");

  const documentCount = await prisma.document.count({ where: { documentTypeId } });
  if (documentCount > 0) {
    throw new DepartmentError(
      409,
      "document_type_in_use",
      `${documentCount} document${documentCount === 1 ? "" : "s"} use this type — it cannot be deleted.`,
    );
  }

  const remaining = await prisma.documentType.count({ where: { departmentId } });
  if (remaining <= 1) {
    throw new DepartmentError(
      400,
      "last_document_type",
      "A department needs at least one document type — uploads have nothing to attach to otherwise.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.fieldDef.deleteMany({ where: { documentTypeId } });
    await tx.documentType.delete({ where: { id: documentTypeId } });
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "config_change",
    departmentId,
    targetDescription: `Document type deleted: ${existing.name}`,
  });

  return { deleted: true };
}

// ───────────────────────── Roles ─────────────────────────

async function loadRoles(deps: Deps, departmentId: string) {
  return deps.prisma.role.findMany({ where: { departmentId }, orderBy: { createdAt: "asc" } });
}

export async function createRole(deps: Deps, actor: Actor, departmentId: string, input: UpsertRoleInput) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.change_role");

  const permissions = input.permissions as PermissionMap;
  validatePermissionMap(input.name, permissions);

  const existing = await loadRoles(deps, departmentId);
  if (existing.some((r) => r.name.toLowerCase() === input.name.toLowerCase())) {
    throw new DepartmentError(409, "role_name_taken", "A role with that name already exists in this department.");
  }

  const created = await prisma.role.create({
    data: {
      organizationId: actor.organizationId,
      departmentId,
      name: input.name,
      isSystem: false,
      permissions: applyPermissionDependencies(permissions) as Prisma.InputJsonValue,
    },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "role_change",
    departmentId,
    targetDescription: `Role created: ${created.name}`,
  });

  return created;
}

export async function copyRole(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  roleId: string,
  newName: string,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.change_role");

  const source = await prisma.role.findFirst({ where: { id: roleId, departmentId } });
  if (!source) throw new DepartmentError(404, "role_not_found", "Role not found.");

  const existing = await loadRoles(deps, departmentId);
  if (existing.some((r) => r.name.toLowerCase() === newName.toLowerCase())) {
    throw new DepartmentError(409, "role_name_taken", "A role with that name already exists in this department.");
  }

  // A copy is never a system role — the built-ins are undeletable precisely because they are the
  // floor a department can't fall below (Feature Spec §2A.8 rule 4); a duplicate of one isn't.
  const created = await prisma.role.create({
    data: {
      organizationId: actor.organizationId,
      departmentId,
      name: newName,
      isSystem: false,
      permissions: source.permissions as Prisma.InputJsonValue,
    },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "role_change",
    departmentId,
    targetDescription: `Role copied: ${source.name} → ${created.name}`,
  });

  return created;
}

export async function updateRole(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  roleId: string,
  input: UpsertRoleInput,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.change_role");

  const roles = await loadRoles(deps, departmentId);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new DepartmentError(404, "role_not_found", "Role not found.");

  const permissions = input.permissions as PermissionMap;
  validatePermissionMap(input.name, permissions);

  if (roles.some((r) => r.id !== roleId && r.name.toLowerCase() === input.name.toLowerCase())) {
    throw new DepartmentError(409, "role_name_taken", "A role with that name already exists in this department.");
  }

  // Removing the last Department-Admin-capable role would leave the department unadministrable.
  const wouldRemainAdminCapable = roles.some((r) =>
    r.id === roleId ? hasDepartmentAdminCapability(permissions) : hasDepartmentAdminCapability(r.permissions),
  );
  if (!wouldRemainAdminCapable) {
    throw new DepartmentError(
      400,
      "no_department_admin_role",
      "This is the department's only role that can administer it — keep its member and configuration permissions.",
    );
  }

  const updated = await prisma.role.update({
    where: { id: roleId },
    data: {
      name: input.name,
      permissions: applyPermissionDependencies(permissions) as Prisma.InputJsonValue,
    },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "permission_change",
    departmentId,
    targetDescription: `Role updated: ${updated.name}`,
  });

  return updated;
}

export async function deleteRole(deps: Deps, actor: Actor, departmentId: string, roleId: string) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.change_role");

  const roles = await loadRoles(deps, departmentId);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new DepartmentError(404, "role_not_found", "Role not found.");

  if (role.isSystem) {
    throw new DepartmentError(
      400,
      "system_role",
      `"${role.name}" is a built-in role and cannot be deleted.`,
    );
  }

  const memberCount = await prisma.membership.count({ where: { roleId } });
  if (memberCount > 0) {
    throw new DepartmentError(
      409,
      "role_in_use",
      `${memberCount} member${memberCount === 1 ? "" : "s"} still hold this role — move them to another role first.`,
    );
  }

  if (!roles.some((r) => r.id !== roleId && hasDepartmentAdminCapability(r.permissions))) {
    throw new DepartmentError(
      400,
      "no_department_admin_role",
      "This is the department's only role that can administer it.",
    );
  }

  await prisma.role.delete({ where: { id: roleId } });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "role_change",
    departmentId,
    targetDescription: `Role deleted: ${role.name}`,
  });

  return { deleted: true };
}

// ───────────────────────── Members ─────────────────────────

/** Nobody hands out a role with more access than they hold here themselves (see canGrantRole). */
async function assertCanGrantRole(deps: Deps, actor: Actor, departmentId: string, rolePermissions: unknown) {
  if (!(await canGrantRole(deps.prisma, actor, departmentId, rolePermissions))) {
    throw new DepartmentError(
      403,
      "role_exceeds_yours",
      "You can't give someone a role with more access than your own.",
    );
  }
}

export async function addMember(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  userId: string,
  roleId: string,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.invite");

  const role = await prisma.role.findFirst({ where: { id: roleId, departmentId } });
  if (!role) throw new DepartmentError(404, "role_not_found", "Role not found in this department.");
  await assertCanGrantRole(deps, actor, departmentId, role.permissions);

  await assertUsersAreInOrganization(deps, actor.organizationId, [userId]);

  const existing = await prisma.membership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
  });
  if (existing) {
    throw new DepartmentError(409, "already_a_member", "That user already has a role in this department.");
  }

  const membership = await prisma.membership.create({
    data: { organizationId: actor.organizationId, userId, departmentId, roleId, status: "active" },
    include: { user: true, role: true },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "member_change",
    departmentId,
    targetDescription: `${membership.user.email} added as ${membership.role.name}`,
  });

  return {
    userId: membership.userId,
    email: membership.user.email,
    fullName: membership.user.fullName,
    roleId: membership.roleId,
    roleName: membership.role.name,
    status: membership.status,
  };
}

export async function changeMemberRole(
  deps: Deps,
  actor: Actor,
  departmentId: string,
  userId: string,
  roleId: string,
) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.change_role");

  const role = await prisma.role.findFirst({ where: { id: roleId, departmentId } });
  if (!role) throw new DepartmentError(404, "role_not_found", "Role not found in this department.");
  await assertCanGrantRole(deps, actor, departmentId, role.permissions);

  const membership = await prisma.membership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
    include: { role: true },
  });
  if (!membership || membership.organizationId !== actor.organizationId) {
    throw new DepartmentError(404, "member_not_found", "That user is not a member of this department.");
  }

  await assertNotLastDepartmentAdmin(deps, departmentId, userId, membership.roleId, role.id);

  const updated = await prisma.membership.update({
    where: { userId_departmentId: { userId, departmentId } },
    data: { roleId },
    include: { user: true, role: true },
  });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "role_change",
    departmentId,
    targetDescription: `${updated.user.email}: ${membership.role.name} → ${updated.role.name}`,
  });

  return { userId, roleId: updated.roleId, roleName: updated.role.name };
}

export async function removeMember(deps: Deps, actor: Actor, departmentId: string, userId: string) {
  const { prisma } = deps;
  await assertDepartmentPermission(deps, actor, departmentId, "members.remove");

  const membership = await prisma.membership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
    include: { user: true, role: true },
  });
  if (!membership || membership.organizationId !== actor.organizationId) {
    throw new DepartmentError(404, "member_not_found", "That user is not a member of this department.");
  }

  await assertNotLastDepartmentAdmin(deps, departmentId, userId, membership.roleId, null);

  // Data Model §2.3: removing a user from a department deletes the membership only — the global
  // user account and their memberships in other departments are untouched.
  await prisma.membership.delete({ where: { userId_departmentId: { userId, departmentId } } });

  await logAuditEvent(prisma, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "member_change",
    departmentId,
    targetDescription: `${membership.user.email} removed from the department`,
  });

  return { removed: true };
}

// Feature Spec §3 Step 4: "a department must always retain at least one Department Admin
// (removing the last is blocked)". This is the *member*-side half of that guardrail — the
// role-side half lives in updateRole/deleteRole above.
async function assertNotLastDepartmentAdmin(
  deps: Deps,
  departmentId: string,
  userId: string,
  currentRoleId: string,
  nextRoleId: string | null,
) {
  const { prisma } = deps;
  const roles = await loadRoles(deps, departmentId);
  const currentRole = roles.find((r) => r.id === currentRoleId);
  if (!currentRole || !hasDepartmentAdminCapability(currentRole.permissions)) return;

  const nextRole = nextRoleId ? roles.find((r) => r.id === nextRoleId) : null;
  if (nextRole && hasDepartmentAdminCapability(nextRole.permissions)) return;

  const adminRoleIds = roles.filter((r) => hasDepartmentAdminCapability(r.permissions)).map((r) => r.id);
  const otherAdmins = await prisma.membership.count({
    where: {
      departmentId,
      status: "active",
      roleId: { in: adminRoleIds },
      userId: { not: userId },
    },
  });

  if (otherAdmins === 0) {
    throw new DepartmentError(
      400,
      "last_department_admin",
      "This is the department's last administrator — assign someone else first.",
    );
  }
}

// Exposed for the role editor so the client renders exactly the catalogue the server validates
// against, rather than keeping its own copy that can drift.
export { PERMISSION_CATALOGUE, PERMISSION_DEPENDENCIES, emptyPermissionMap } from "../../lib/permissions.js";
