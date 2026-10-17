import type { FieldType } from "@prisma/client";
import { DEFAULT_DEPARTMENT_RULES, type DepartmentRules } from "./department.schemas.js";
import { ALL_PERMISSION_KEYS, PERMISSION_CATALOGUE, permissionMapFrom, type PermissionMap } from "../../lib/permissions.js";

// The six templates shipped at launch (Scope doc §3.2: Healthcare, Education, Accounts, HR,
// Legal, Blank). A template is a *bundle* — vocabulary, document types, fields and starter roles
// already filled in (Feature Spec §3 Step 1) — and is a starting point, never a cage: everything
// it creates is ordinary editable data after the wizard runs.
//
// Deliberately plain data, not logic: DEP-5 ("save a configured department as a template") is
// Release 2, and when it lands it needs to produce the same shape as what's below without a
// rewrite. Nothing here may branch on sector — a template is read, never interpreted.
//
// Step-5 rules: only the `defaultSharing` half is carried, because that is the only half the
// Data Model can store (see §2.4's note — a tag label has no column on `document`, and
// folder-conditioned rules need folders that don't exist yet).

export interface TemplateFieldDef {
  label: string;
  fieldType: FieldType;
  isRequired?: boolean;
  isFilterable?: boolean;
  isTitle?: boolean;
  options?: string[];
}

export interface TemplateDocumentType {
  name: string;
  idCode: string;
  fields: TemplateFieldDef[];
}

export interface TemplateRole {
  name: string;
  isSystem?: boolean;
  granted: string[];
}

export interface DepartmentTemplate {
  key: string;
  name: string;
  description: string;
  suggestedName: string;
  suggestedIdPrefix: string;
  subjectTerm: string;
  identifierTerm: string;
  documentTypes: TemplateDocumentType[];
  roles: TemplateRole[];
  rules: DepartmentRules;
}

// Feature Spec §3 Step 5: "HR and Medical keep external sharing off; Legal may enable it for
// auditors." The default matters more than the exception, because it applies to the thousands of
// documents nobody thinks to configure — so every template except Legal starts closed.
const SHARING_CLOSED: DepartmentRules = DEFAULT_DEPARTMENT_RULES;
const SHARING_OPEN: DepartmentRules = {
  defaultSharing: { externalLinksEnabled: true, linkExpiryDays: 14 },
};

// ── Starter role permission sets ────────────────────────────────────────────
//
// Department Admin gets every catalogue key that is *active in R1*. The R2 keys (workflow,
// reports, saved searches) are deliberately left off: granting a permission that does nothing
// today would silently confer approval authority on the day Release 2 turns workflow on, which
// is exactly the kind of invisible privilege the permission model exists to prevent.
const R1_ACTIVE_KEYS = PERMISSION_CATALOGUE.flatMap((g) =>
  g.permissions.filter((p) => !p.inactiveInR1).map((p) => p.key),
);

const DEPARTMENT_ADMIN_KEYS = R1_ACTIVE_KEYS;

// Everyday contributor: full document handling in their department, no destructive or
// administrative reach (no delete, no external share, no audit, no configuration).
const STAFF_KEYS = [
  "documents.view",
  "documents.upload",
  "documents.download",
  "documents.preview",
  "documents.version_history",
  "documents.upload_version",
  "documents.edit_metadata",
  "folders.create",
  "folders.rename",
  "sharing.share",
  "search.search",
  "search.advanced_search",
];

// The Auditor pattern from Feature Spec §2A.4: view audit WITHOUT export audit — export is the
// point at which data leaves the organization, so it is granted separately and never bundled.
const AUDITOR_KEYS = [
  "documents.view",
  "documents.preview",
  "documents.version_history",
  "search.search",
  "search.advanced_search",
  "audit.view_audit",
];

// Manager-shaped: Staff plus the destructive and outbound-sharing capabilities, plus audit view.
const MANAGER_KEYS = [
  ...STAFF_KEYS,
  "documents.delete",
  "documents.restore",
  "folders.delete",
  "folders.move",
  "sharing.remove_share",
  "sharing.create_link",
  "sharing.cross_department_share",
  "audit.view_audit",
  "members.invite",
];

function systemRoles(): TemplateRole[] {
  return [
    { name: "Department Admin", isSystem: true, granted: DEPARTMENT_ADMIN_KEYS },
    { name: "Staff", isSystem: true, granted: STAFF_KEYS },
  ];
}

const DATE_FIELD = (label: string): TemplateFieldDef => ({
  label,
  fieldType: "date",
  isRequired: false,
  isFilterable: true,
});

export const DEPARTMENT_TEMPLATES: DepartmentTemplate[] = [
  {
    key: "healthcare",
    name: "Healthcare",
    description: "Patient records, scans, prescriptions and consent forms.",
    suggestedName: "Medical Records",
    suggestedIdPrefix: "MED",
    subjectTerm: "Patient",
    identifierTerm: "Patient ID",
    documentTypes: [
      {
        name: "Medical Report",
        idCode: "RPT",
        fields: [
          { label: "Patient Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Patient ID", fieldType: "id", isRequired: true },
          DATE_FIELD("Report Date"),
          { label: "Department", fieldType: "dropdown", options: ["General", "Cardiology", "Orthopaedics", "Paediatrics"] },
          { label: "Consulting Doctor", fieldType: "person" },
        ],
      },
      {
        name: "Scan",
        idCode: "SCN",
        fields: [
          { label: "Patient Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Patient ID", fieldType: "id", isRequired: true },
          { label: "Scan Type", fieldType: "dropdown", options: ["X-Ray", "MRI", "CT", "Ultrasound"], isRequired: true },
          DATE_FIELD("Scan Date"),
        ],
      },
      {
        name: "Prescription",
        idCode: "PRE",
        fields: [
          { label: "Patient Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Patient ID", fieldType: "id", isRequired: true },
          DATE_FIELD("Prescribed On"),
          { label: "Prescribing Doctor", fieldType: "person" },
        ],
      },
      {
        name: "Consent Form",
        idCode: "CNS",
        fields: [
          { label: "Patient Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Patient ID", fieldType: "id", isRequired: true },
          { label: "Procedure", fieldType: "text" },
          DATE_FIELD("Signed On"),
        ],
      },
    ],
    roles: [...systemRoles(), { name: "Medical Records Officer", granted: MANAGER_KEYS }],
    rules: SHARING_CLOSED,
  },
  {
    key: "education",
    name: "Education",
    description: "Student records, transcripts, certificates and admission forms.",
    suggestedName: "Student Records",
    suggestedIdPrefix: "EDU",
    subjectTerm: "Student",
    identifierTerm: "Student ID",
    documentTypes: [
      {
        name: "Student Record",
        idCode: "REC",
        fields: [
          { label: "Student Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Student ID", fieldType: "id", isRequired: true },
          { label: "Programme", fieldType: "dropdown", options: ["Undergraduate", "Postgraduate", "Diploma"] },
          { label: "Academic Year", fieldType: "text" },
        ],
      },
      {
        name: "Transcript",
        idCode: "TRN",
        fields: [
          { label: "Student Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Student ID", fieldType: "id", isRequired: true },
          { label: "Semester", fieldType: "text" },
          DATE_FIELD("Issued On"),
        ],
      },
      {
        name: "Certificate",
        idCode: "CRT",
        fields: [
          { label: "Student Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Certificate Type", fieldType: "dropdown", options: ["Course Completion", "Transfer", "Bonafide", "Character"] },
          DATE_FIELD("Issued On"),
        ],
      },
      {
        name: "Admission Form",
        idCode: "ADM",
        fields: [
          { label: "Applicant Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Application Number", fieldType: "id", isRequired: true },
          DATE_FIELD("Submitted On"),
        ],
      },
    ],
    roles: [...systemRoles(), { name: "Registrar", granted: MANAGER_KEYS }],
    rules: SHARING_CLOSED,
  },
  {
    key: "accounts",
    name: "Accounts",
    description: "Invoices, receipts, purchase orders and statements.",
    suggestedName: "Accounts",
    suggestedIdPrefix: "ACC",
    subjectTerm: "Invoice",
    identifierTerm: "Invoice Number",
    documentTypes: [
      {
        name: "Invoice",
        idCode: "INV",
        fields: [
          { label: "Vendor", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Invoice Number", fieldType: "id", isRequired: true },
          { label: "Amount", fieldType: "number", isRequired: true },
          DATE_FIELD("Invoice Date"),
          DATE_FIELD("Due Date"),
        ],
      },
      {
        name: "Receipt",
        idCode: "RCP",
        fields: [
          { label: "Paid To", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Receipt Number", fieldType: "id" },
          { label: "Amount", fieldType: "number", isRequired: true },
          DATE_FIELD("Payment Date"),
        ],
      },
      {
        name: "Purchase Order",
        idCode: "PO",
        fields: [
          { label: "Vendor", fieldType: "text", isRequired: true, isTitle: true },
          { label: "PO Number", fieldType: "id", isRequired: true },
          { label: "Amount", fieldType: "number" },
          DATE_FIELD("Raised On"),
        ],
      },
      {
        name: "Statement",
        idCode: "STM",
        fields: [
          { label: "Account", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Period", fieldType: "text" },
          DATE_FIELD("Statement Date"),
        ],
      },
    ],
    roles: [
      ...systemRoles(),
      { name: "Finance Manager", granted: MANAGER_KEYS },
      { name: "Auditor", granted: AUDITOR_KEYS },
    ],
    rules: SHARING_CLOSED,
  },
  {
    key: "hr",
    name: "HR",
    description: "Employee contracts, records, policies and forms.",
    suggestedName: "Human Resources",
    suggestedIdPrefix: "HR",
    subjectTerm: "Employee",
    identifierTerm: "Employee ID",
    documentTypes: [
      {
        name: "Contract",
        idCode: "CON",
        fields: [
          { label: "Employee Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Employee ID", fieldType: "id", isRequired: true },
          { label: "Contract Type", fieldType: "dropdown", options: ["Permanent", "Fixed-term", "Probation", "Consultant"] },
          DATE_FIELD("Start Date"),
          DATE_FIELD("End Date"),
        ],
      },
      {
        name: "Employee Record",
        idCode: "REC",
        fields: [
          { label: "Employee Name", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Employee ID", fieldType: "id", isRequired: true },
          { label: "Department", fieldType: "text" },
          { label: "Reporting Manager", fieldType: "person" },
        ],
      },
      {
        name: "Policy",
        idCode: "POL",
        fields: [
          { label: "Policy Title", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Version", fieldType: "text" },
          DATE_FIELD("Effective From"),
        ],
      },
      {
        name: "Form",
        idCode: "FRM",
        fields: [
          { label: "Form Title", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Employee ID", fieldType: "id" },
          DATE_FIELD("Submitted On"),
        ],
      },
    ],
    roles: [
      ...systemRoles(),
      { name: "HR Manager", granted: MANAGER_KEYS },
      { name: "Recruiter", granted: STAFF_KEYS },
    ],
    rules: SHARING_CLOSED,
  },
  {
    key: "legal",
    name: "Legal",
    description: "Contracts, case files, court filings and legal opinions.",
    suggestedName: "Legal",
    suggestedIdPrefix: "LEG",
    subjectTerm: "Matter",
    identifierTerm: "Matter Number",
    documentTypes: [
      {
        name: "Contract",
        idCode: "CON",
        fields: [
          { label: "Counterparty", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Contract Number", fieldType: "id" },
          DATE_FIELD("Signed On"),
          DATE_FIELD("Expires On"),
          { label: "Value", fieldType: "number" },
        ],
      },
      {
        name: "Case File",
        idCode: "CAS",
        fields: [
          { label: "Case Title", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Matter Number", fieldType: "id", isRequired: true },
          { label: "Status", fieldType: "dropdown", options: ["Open", "In progress", "Closed", "On hold"] },
          { label: "Lead Counsel", fieldType: "person" },
        ],
      },
      {
        name: "Court Filing",
        idCode: "FIL",
        fields: [
          { label: "Filing Title", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Matter Number", fieldType: "id" },
          DATE_FIELD("Filed On"),
        ],
      },
      {
        name: "Legal Opinion",
        idCode: "OPN",
        fields: [
          { label: "Subject", fieldType: "text", isRequired: true, isTitle: true },
          { label: "Matter Number", fieldType: "id" },
          DATE_FIELD("Issued On"),
        ],
      },
    ],
    roles: [
      ...systemRoles(),
      { name: "Legal Counsel", granted: MANAGER_KEYS },
      { name: "Auditor", granted: AUDITOR_KEYS },
    ],
    rules: SHARING_OPEN,
  },
  {
    key: "blank",
    name: "Blank",
    description: "Start from scratch — one generic document type, no preset vocabulary.",
    suggestedName: "",
    suggestedIdPrefix: "",
    subjectTerm: "Record",
    identifierTerm: "Reference",
    documentTypes: [
      {
        name: "Document",
        idCode: "DOC",
        fields: [
          { label: "Title", fieldType: "text", isRequired: true, isTitle: true },
          DATE_FIELD("Document Date"),
        ],
      },
    ],
    roles: systemRoles(),
    rules: SHARING_CLOSED,
  },
];

export function findTemplate(key: string): DepartmentTemplate | undefined {
  return DEPARTMENT_TEMPLATES.find((t) => t.key === key);
}

export function templateRolePermissions(role: TemplateRole): PermissionMap {
  return permissionMapFrom(role.granted.filter((k) => ALL_PERMISSION_KEYS.includes(k)));
}
