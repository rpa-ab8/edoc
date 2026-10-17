import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "../components/AppShell";
import { inputBase, inputClass, primaryButtonBase, secondaryButtonBase } from "../components/AuthCard";
import { Select } from "../components/Select";
import {
  DocumentTypeEditor,
  cleanDocumentTypes,
  validateDocumentTypes,
} from "../components/department/DocumentTypeEditor";
import { RoleMatrixEditor, isDepartmentAdminRole } from "../components/department/RoleMatrixEditor";
import { RulesEditor } from "../components/department/RulesEditor";
import { CheckCircleIcon, DocumentIcon, FolderIcon, UsersIcon } from "../components/icons";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import {
  fetchPermissionCatalogue,
  fetchTemplates,
  DEFAULT_DEPARTMENT_RULES,
  type DepartmentRules,
  type DepartmentTemplate,
  type DraftDocumentType,
  type DraftRole,
} from "../lib/departments";

// Categorical only: one tint per template so the six are distinguishable at a glance.
const TEMPLATE_TINTS = [
  "bg-cat-teal-tint text-cat-teal",
  "bg-cat-green-tint text-cat-green",
  "bg-cat-orange-tint text-cat-orange",
  "bg-cat-indigo-tint text-cat-indigo",
  "bg-primary-tint text-primary",
  "bg-surface-muted text-subtle",
];

const CARD_SHADOW = "shadow-card";

const STEPS = [
  { title: "Name & template", hint: "Start from the closest preset" },
  { title: "Vocabulary", hint: "The words this department uses" },
  { title: "Document types", hint: "The schema — types and their fields" },
  { title: "Roles & members", hint: "Who can do what" },
  { title: "Rules", hint: "Automation defaults" },
];

interface OrgMember {
  userId: string;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
}

export function DepartmentCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromOnboarding = searchParams.get("from") === "onboarding";
  const { organizations, currentOrganizationId, user } = useAuthStore();
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);

  const cardRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [idPrefix, setIdPrefix] = useState("");
  const [subjectTerm, setSubjectTerm] = useState("");
  const [identifierTerm, setIdentifierTerm] = useState("");
  const [documentTypes, setDocumentTypes] = useState<DraftDocumentType[]>([]);
  const [roles, setRoles] = useState<DraftRole[]>([]);
  const [members, setMembers] = useState<{ userId: string; roleName: string }[]>([]);
  const [rules, setRules] = useState<DepartmentRules>(DEFAULT_DEPARTMENT_RULES);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: templates } = useQuery({ queryKey: ["department-templates"], queryFn: fetchTemplates });
  const { data: catalogue } = useQuery({
    queryKey: ["permission-catalogue"],
    queryFn: fetchPermissionCatalogue,
  });
  const { data: directory } = useQuery({
    queryKey: ["org-members"],
    queryFn: () => apiRequest<{ members: OrgMember[] }>("/organizations/current/members"),
  });

  const template = templates?.find((t) => t.key === templateKey);

  function applyTemplate(next: DepartmentTemplate) {
    setTemplateKey(next.key);
    setName(next.suggestedName);
    setIdPrefix(next.suggestedIdPrefix);
    setSubjectTerm(next.subjectTerm);
    setIdentifierTerm(next.identifierTerm);
    setDocumentTypes(structuredClone(next.documentTypes));
    setRoles(structuredClone(next.roles));
    setRules(structuredClone(next.rules));
    setMembers([]);
  }

  // A step change swaps the whole card's contents — without this, moving from a long step (the
  // permission matrix) to a short one leaves you scrolled past the new step's heading.
  useEffect(() => {
    setError(null);
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step]);

  const stepError = useMemo(() => {
    if (step === 0) {
      if (!templateKey) return "Pick a template to start from.";
      if (!name.trim()) return "Give the department a name.";
      if (!/^[A-Z0-9]{2,8}$/.test(idPrefix)) return "The ID prefix is 2–8 uppercase letters or digits.";
    }
    if (step === 1) {
      if (!subjectTerm.trim() || !identifierTerm.trim()) return "Both terms are needed.";
    }
    if (step === 2) return validateDocumentTypes(documentTypes);
    if (step === 3) {
      if (roles.some((r) => !r.name.trim())) return "Every role needs a name.";
      const names = roles.map((r) => r.name.trim().toLowerCase());
      if (new Set(names).size !== names.length) return "Two roles share the same name.";
      if (!roles.some(isDepartmentAdminRole))
        return "Keep at least one role that can administer this department.";
    }
    return null;
  }, [step, templateKey, name, idPrefix, subjectTerm, identifierTerm, documentTypes, roles]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const { department } = await apiRequest<{ department: { id: string } }>("/departments", {
        method: "POST",
        body: JSON.stringify({
          templateKey,
          name: name.trim(),
          idPrefix,
          subjectTerm: subjectTerm.trim(),
          identifierTerm: identifierTerm.trim(),
          documentTypes: cleanDocumentTypes(documentTypes),
          roles: roles.map((r) => ({ name: r.name.trim(), isSystem: r.isSystem, permissions: r.permissions })),
          rules,
          members: members.filter((m) => m.userId !== user?.id),
        }),
      });
      // Reached from the first-run onboarding wizard? Go back to it so the flow completes,
      // rather than stranding a brand-new Super Admin on a department screen mid-onboarding.
      navigate(fromOnboarding ? "/onboarding" : `/departments/${department.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  if (!currentOrg?.isSuperAdmin) {
    return (
      <AppShell>
        <p className="text-[14.5px] text-muted">Only the Super Admin can create a department.</p>
      </AppShell>
    );
  }

  const otherMembers = (directory?.members ?? []).filter((m) => m.userId !== user?.id);

  return (
    <AppShell>
      <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">New department</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Everything a department needs — its words, its schema and its roles — in five steps. All of
        it stays editable afterwards.
      </p>

      <ol className="mt-8 flex flex-wrap gap-2.5">
        {STEPS.map((s, index) => {
          const state = index === step ? "current" : index < step ? "done" : "todo";
          return (
            <li key={s.title} className="min-w-[150px] flex-1">
              <button
                type="button"
                onClick={() => index < step && setStep(index)}
                disabled={index > step}
                className={`w-full rounded-xl border px-4 py-3.5 text-left transition-colors ${
                  state === "current"
                    ? "border-primary bg-primary-tint shadow-card"
                    : state === "done"
                      ? "border-line bg-surface hover:border-primary/30"
                      : "border-line-muted bg-surface-muted/60"
                }`}
              >
                <span className="flex items-center gap-2 font-mono text-[11.5px] text-subtle">
                  {state === "done" ? <CheckCircleIcon size={13} className="text-success" /> : null}
                  Step {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={`mt-1.5 block text-[14.5px] font-semibold ${
                    state === "todo" ? "text-subtle" : "text-ink"
                  }`}
                >
                  {s.title}
                </span>
                <span className="mt-1 block text-[12.5px] text-subtle">{s.hint}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div ref={cardRef} className={`mt-6 scroll-mt-8 rounded-2xl border border-line bg-surface p-8 ${CARD_SHADOW}`}>
        {step === 0 && (
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-ink">Start from a template</h2>
            <p className="mt-1 text-[14.5px] text-muted">
              A template fills in the document types, fields, vocabulary and roles for the steps
              that follow. It is a starting point, never a cage.
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(templates ?? []).map((t, index) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className={`group relative overflow-hidden rounded-2xl border p-6 text-left transition-all ${
                    templateKey === t.key
                      ? "border-primary bg-primary-tint shadow-card"
                      : "border-line bg-surface hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-card"
                  }`}
                >
                  {templateKey === t.key && (
                    <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-primary" />
                  )}
                  <span className="flex items-center justify-between">
                    <span
                      className={`flex h-11 w-11 items-center justify-center rounded-xl ${
                        templateKey === t.key
                          ? "bg-primary text-white"
                          : TEMPLATE_TINTS[index % TEMPLATE_TINTS.length]
                      }`}
                    >
                      <FolderIcon size={19} />
                    </span>
                    {templateKey === t.key && <CheckCircleIcon size={20} className="text-primary" />}
                  </span>
                  <span className="mt-3.5 block text-[15.5px] font-semibold text-ink">{t.name}</span>
                  <span className="mt-1.5 block text-[13.5px] leading-relaxed text-muted">{t.description}</span>
                  <span className="mt-3.5 block font-mono text-[12px] text-subtle">
                    {t.documentTypes.length} type{t.documentTypes.length === 1 ? "" : "s"} ·{" "}
                    {t.roles.length} role{t.roles.length === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            </div>

            {template && (
              <div className="mt-7 grid gap-5 sm:grid-cols-2">
                <div>
                  <label className="mb-2 block text-[13.5px] font-medium text-ink">Department name</label>
                  <input
                    className={inputClass}
                    value={name}
                    placeholder="Human Resources"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-2 block text-[13.5px] font-medium text-ink">ID prefix</label>
                  <input
                    className={`${inputClass} font-mono uppercase`}
                    value={idPrefix}
                    placeholder="HR"
                    maxLength={8}
                    onChange={(e) => setIdPrefix(e.target.value.toUpperCase())}
                  />
                  <p className="mt-2">
                    <span className="plate inline-block px-2.5 py-1 text-[12px]">
                      {`${idPrefix || "«PREFIX»"}-${documentTypes[0]?.idCode || "TYPE"}-${new Date().getFullYear()}-00001`}
                    </span>
                  </p>
                  <p className="mt-1 text-[12px] text-subtle">
                    Editable later — changing it never rewrites IDs already issued.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-ink">The words this department uses</h2>
            <p className="mt-1 text-[14.5px] text-muted">
              The system stores a generic concept and shows your word for it — so the same screens
              read naturally in a clinic, a school and an accounts office.
            </p>

            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <div>
                <label className="mb-2 block text-[13.5px] font-medium text-ink">
                  What this department manages
                </label>
                <input
                  className={inputClass}
                  value={subjectTerm}
                  placeholder="Employee"
                  onChange={(e) => setSubjectTerm(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-2 block text-[13.5px] font-medium text-ink">Its primary identifier</label>
                <input
                  className={inputClass}
                  value={identifierTerm}
                  placeholder="Employee ID"
                  onChange={(e) => setIdentifierTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-7 rounded-2xl border border-line bg-surface-muted/60 p-6">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle">Live preview</p>
              <div className="mt-4 space-y-3">
                <span className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-white">
                  <DocumentIcon size={16} /> Add {(subjectTerm || "record").toLowerCase()} document
                </span>
                <p className="text-[14px] font-semibold text-ink">
                  {subjectTerm || "Record"} documents
                </p>
                <input
                  className={`${inputBase} max-w-sm`}
                  placeholder={`Search by ${(identifierTerm || "reference").toLowerCase()}…`}
                  readOnly
                />
                <p className="text-[13px] text-subtle">
                  No {(subjectTerm || "record").toLowerCase()} documents in this folder yet.
                </p>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-ink">Document types and their fields</h2>
            <p className="mt-1 text-[14.5px] text-muted">
              Each type carries its own field set. One field per type is the title — the headline
              shown in lists and search results.
            </p>
            <div className="mt-6">
              <DocumentTypeEditor value={documentTypes} onChange={setDocumentTypes} idPrefix={idPrefix} />
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-ink">Roles and permissions</h2>
            <p className="mt-1 text-[14.5px] text-muted">
              The template's roles, ready to adjust. Copy one to make a variant, then tick or untick
              cells. This matrix is the department default — folder overrides can tighten it later,
              never loosen it.
            </p>

            <div className="mt-6">
              {catalogue && (
                <RoleMatrixEditor
                  roles={roles}
                  onChange={setRoles}
                  groups={catalogue.groups}
                  dependencies={catalogue.dependencies}
                />
              )}
            </div>

            <div className="mt-8">
              <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                <UsersIcon size={17} className="text-subtle" /> Members
              </h3>
              <p className="mt-1 text-[14px] text-muted">
                Drawn from the organization's user directory — people are not created here. You are
                added automatically as this department's first administrator.
              </p>

              {otherMembers.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {otherMembers.map((m) => {
                    const assigned = members.find((x) => x.userId === m.userId);
                    return (
                      <div
                        key={m.userId}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3"
                      >
                        <span>
                          <span className="block text-[13.5px] font-medium text-ink">{m.fullName}</span>
                          <span className="block text-[13px] text-subtle">{m.email}</span>
                        </span>
                        <Select
                          ariaLabel={`Role for ${m.fullName}`}
                          className="w-60"
                          value={assigned?.roleName ?? ""}
                          options={[
                            { value: "", label: "Not in this department" },
                            ...roles.map((r) => ({ value: r.name, label: r.name })),
                          ]}
                          onChange={(roleName) =>
                            setMembers((prev) => {
                              const rest = prev.filter((x) => x.userId !== m.userId);
                              return roleName ? [...rest, { userId: m.userId, roleName }] : rest;
                            })
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-5 text-[13.5px] text-subtle">
                  Nobody else is in the organization's directory yet. Add people from the user
                  directory, then give them a role here or from the department's Members tab.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-ink">Rules and automation</h2>
            <p className="mt-1 text-[14.5px] text-muted">
              Where the department starts to run itself — the defaults that apply to everything
              nobody configures by hand.
            </p>

            <div className="mt-6">
              <RulesEditor value={rules} onChange={setRules} subjectTerm={subjectTerm} />
            </div>

            <div className="mt-7 rounded-2xl border border-line bg-surface-muted/60 p-6">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle">Ready to create</p>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["Department", name],
                  ["ID prefix", idPrefix],
                  ["Document types", String(documentTypes.length)],
                  ["Roles", String(roles.length)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[12px] text-subtle">{label}</dt>
                    <dd className="mt-0.5 text-[14px] font-semibold text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-6 rounded-lg bg-danger-tint px-4 py-2.5 text-[13px] text-danger">{error}</p>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-line-muted pt-6">
          <button
            type="button"
            onClick={() =>
              step === 0 ? navigate(fromOnboarding ? "/onboarding" : "/departments") : setStep(step - 1)
            }
            className={`${secondaryButtonBase} px-6`}
          >
            {step === 0 ? "Cancel" : "Back"}
          </button>
          {stepError && <span className="text-[13px] text-subtle">{stepError}</span>}
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={stepError !== null}
              onClick={() => setStep(step + 1)}
              className={`${primaryButtonBase} ml-auto px-8`}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={submit}
              className={`${primaryButtonBase} ml-auto px-8`}
            >
              {submitting ? "Creating…" : "Create department"}
            </button>
          )}
        </div>
      </div>
    </AppShell>
  );
}
