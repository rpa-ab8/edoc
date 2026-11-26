import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "../components/AppShell";
import { StatusPill, inputBase, inputClass, primaryButtonBase } from "../components/AuthCard";
import { Select } from "../components/Select";
import { SearchSelect } from "../components/SearchableSelect";
import {
  DocumentTypeEditor,
  cleanDocumentTypes,
  validateDocumentTypes,
} from "../components/department/DocumentTypeEditor";
import { RoleMatrixEditor, isDepartmentAdminRole } from "../components/department/RoleMatrixEditor";
import { RulesEditor } from "../components/department/RulesEditor";
import { RetentionPanel } from "../components/department/RetentionPanel";
import { ChevronRightIcon, MailIcon, TrashIcon, UsersIcon } from "../components/icons";
import { apiRequest, ApiRequestError } from "../lib/api";
import {
  DEFAULT_DEPARTMENT_RULES,
  fetchAddableMembers,
  fetchDepartment,
  fetchPermissionCatalogue,
  type DepartmentRules,
  type DraftDocumentType,
  type DraftRole,
} from "../lib/departments";
import { fetchMyPermissions } from "../lib/folders";
import { useAuthStore } from "../store/authStore";
import {
  createInvitation,
  fetchDepartmentInvitations,
  resendInvitation,
  revokeInvitation,
} from "../lib/invitations";

const CARD_SHADOW = "shadow-card";

const TABS = ["Overview", "Document types", "Roles", "Members", "Rules", "Retention"] as const;
type Tab = (typeof TABS)[number];

export function DepartmentDetailPage() {
  const { departmentId = "" } = useParams();
  const { organizations, currentOrganizationId } = useAuthStore();
  const isSuperAdmin = organizations.find((o) => o.id === currentOrganizationId)?.isSuperAdmin ?? false;

  const [tab, setTab] = useState<Tab>("Overview");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: department, refetch } = useQuery({
    queryKey: ["department", departmentId],
    queryFn: () => fetchDepartment(departmentId),
  });
  const { data: catalogue } = useQuery({
    queryKey: ["permission-catalogue"],
    queryFn: fetchPermissionCatalogue,
  });
  const { data: invitations, refetch: refetchInvitations } = useQuery({
    queryKey: ["department-invitations", departmentId],
    queryFn: () => fetchDepartmentInvitations(departmentId),
  });

  // What the current user may do in this department — drives which member controls appear. Super
  // Admins resolve to the administrative keys (members.*), so this is correct for them too.
  const { data: access } = useQuery({
    queryKey: ["my-permissions", departmentId, null],
    queryFn: () => fetchMyPermissions(departmentId),
    enabled: Boolean(departmentId),
  });
  const perms = access?.permissions ?? {};
  const canInvite = perms["members.invite"] === true;
  const canChangeRole = perms["members.change_role"] === true;
  const canRemove = perms["members.remove"] === true;
  // PRD v1.2 Department Admin rights — deliberately not part of the Super Admin's baseline.
  const canManageAutoDelete = perms["retention.manage_auto_delete"] === true;
  const canViewUpcoming = perms["retention.view_upcoming_deletions"] === true;
  const canManageHolds = perms["retention.manage_legal_hold"] === true;

  // Each tab appears only for someone who can act on it, so a manager who may only invite lands on
  // Members instead of a page of forms that would refuse to save. Roles stay a Super-Admin concern:
  // a Department Admin's role can't grant itself powers.
  const canEditSettings = isSuperAdmin || perms["configuration.edit_rules"] === true;
  const canEditTypes =
    isSuperAdmin ||
    [
      "configuration.create_document_type",
      "configuration.edit_document_type",
      "configuration.delete_document_type",
      "configuration.edit_metadata_schema",
    ].some((k) => perms[k] === true);
  const visibleTabs = TABS.filter((t) => {
    if (t === "Roles") return isSuperAdmin;
    if (t === "Overview" || t === "Rules") return canEditSettings;
    if (t === "Document types") return canEditTypes;
    if (t === "Retention") return canManageAutoDelete || canViewUpcoming || canManageHolds;
    return true;
  });
  const activeTab: Tab = visibleTabs.includes(tab) ? tab : (visibleTabs[0] ?? "Members");

  const { data: addableMembers } = useQuery({
    queryKey: ["addable-members", departmentId],
    queryFn: () => fetchAddableMembers(departmentId),
    enabled: Boolean(departmentId) && canInvite,
  });

  // Local drafts — the tabs are editors, so they hold their own state until saved.
  const [name, setName] = useState("");
  const [idPrefix, setIdPrefix] = useState("");
  const [subjectTerm, setSubjectTerm] = useState("");
  const [identifierTerm, setIdentifierTerm] = useState("");
  const [depthLimit, setDepthLimit] = useState("");
  const [documentTypes, setDocumentTypes] = useState<DraftDocumentType[]>([]);
  const [roles, setRoles] = useState<DraftRole[]>([]);
  const [rules, setRules] = useState<DepartmentRules>(DEFAULT_DEPARTMENT_RULES);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  // "Add someone who already has an account": pick a person (searchable), pick a role, then Add.
  const [addUserId, setAddUserId] = useState("");
  const [addRoleId, setAddRoleId] = useState("");

  useEffect(() => {
    if (!department) return;
    setName(department.name);
    setIdPrefix(department.idPrefix);
    setSubjectTerm(department.subjectTerm ?? "");
    setIdentifierTerm(department.identifierTerm ?? "");
    setDepthLimit(department.subfolderDepthLimit ? String(department.subfolderDepthLimit) : "");
    setDocumentTypes(structuredClone(department.documentTypes));
    setRoles(structuredClone(department.roles));
    setRules(structuredClone(department.rules ?? DEFAULT_DEPARTMENT_RULES));
  }, [department]);

  async function run(work: () => Promise<void>, successMessage: string) {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await work();
      await refetch();
      setStatus(successMessage);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  // Wait for the caller's permissions too: the tab set depends on them, and showing a guess first
  // would flash the wrong tabs.
  if (!department || !access) {
    return (
      <AppShell>
        <p className="text-[14.5px] text-muted">Loading department…</p>
      </AppShell>
    );
  }

  // Roles this person may hand out: never one with more access than their own (the server enforces
  // the same rule). The Super Admin may grant any role.
  const grantableRoles = department.roles.filter(
    (r) => isSuperAdmin || Object.entries(r.permissions).every(([key, on]) => on !== true || perms[key] === true),
  );
  const roleOption = (r: (typeof department.roles)[number]) => ({
    value: r.id,
    label: r.name,
    hint: r.isDepartmentAdmin ? "Can administer this department" : undefined,
  });

  const saveOverview = () =>
    run(async () => {
      await apiRequest(`/departments/${departmentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(isSuperAdmin ? { name: name.trim() } : {}),
          idPrefix,
          subjectTerm: subjectTerm.trim(),
          identifierTerm: identifierTerm.trim(),
          subfolderDepthLimit: depthLimit ? Number(depthLimit) : null,
        }),
      });
    }, "Department updated.");

  const saveDocumentTypes = () => {
    const problem = validateDocumentTypes(documentTypes);
    if (problem) {
      setError(problem);
      return;
    }
    return run(async () => {
      const cleaned = cleanDocumentTypes(documentTypes);
      const removed = department.documentTypes.filter((t) => !cleaned.some((c) => c.id === t.id));
      for (const type of cleaned) {
        if (type.id) {
          await apiRequest(`/departments/${departmentId}/document-types/${type.id}`, {
            method: "PUT",
            body: JSON.stringify(type),
          });
        } else {
          await apiRequest(`/departments/${departmentId}/document-types`, {
            method: "POST",
            body: JSON.stringify(type),
          });
        }
      }
      for (const type of removed) {
        await apiRequest(`/departments/${departmentId}/document-types/${type.id}`, { method: "DELETE" });
      }
    }, "Document types saved.");
  };

  const saveRoles = () => {
    if (!roles.some(isDepartmentAdminRole)) {
      setError("Keep at least one role that can administer this department.");
      return;
    }
    return run(async () => {
      const removed = department.roles.filter((r) => !roles.some((x) => x.id === r.id));
      for (const role of roles) {
        const body = JSON.stringify({ name: role.name.trim(), permissions: role.permissions });
        if (role.id) {
          await apiRequest(`/departments/${departmentId}/roles/${role.id}`, { method: "PUT", body });
        } else {
          await apiRequest(`/departments/${departmentId}/roles`, { method: "POST", body });
        }
      }
      for (const role of removed) {
        await apiRequest(`/departments/${departmentId}/roles/${role.id}`, { method: "DELETE" });
      }
    }, "Roles saved.");
  };

  const saveRules = () =>
    run(async () => {
      await apiRequest(`/departments/${departmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ rules }),
      });
    }, "Rules saved.");

  // Already filtered server-side (existing members and the Super Admin are excluded).
  const unassigned = addableMembers ?? [];

  return (
    <AppShell backTo={{ label: `Back to ${department.name}`, to: `/w/${department.id}` }}>
      <nav className="flex items-center gap-1.5 text-[13.5px] text-subtle">
        {/* A department admin has no Departments list to go back to — theirs is the workspace. */}
        <Link to={isSuperAdmin ? "/departments" : `/w/${departmentId}`} className="hover:text-primary">
          {isSuperAdmin ? "Departments" : "Files"}
        </Link>
        <ChevronRightIcon size={13} />
        <span className="text-muted">{department.name}</span>
      </nav>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">{department.name}</h1>
        <span className="plate px-3 py-1 text-[12px] font-medium">{department.idPrefix}</span>
        {department.status === "archived" && <StatusPill tone="warning">Archived</StatusPill>}
      </div>
      {/* The configured terms are shown exactly as the admin typed them — "Employee ID" is a
          proper label, and lower-casing it produced "employee id". */}
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Manages {department.subjectTerm ?? "Records"} · identified by{" "}
        {department.identifierTerm ?? "Reference"}
      </p>

      <div className="mt-8 flex flex-wrap gap-1 border-b border-line">
        {visibleTabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setStatus(null);
              setError(null);
            }}
            className={`-mb-px border-b-2 px-4 pb-3 pt-1 text-[15px] font-semibold transition-colors ${
              activeTab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted hover:border-line hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {status && <p className="mt-5 text-[14px] font-medium text-success">{status}</p>}
      {error && <p className="mt-5 text-[14px] font-medium text-danger">{error}</p>}

      <div className="mt-6">
        {activeTab === "Overview" && (
          <div className={`max-w-2xl rounded-2xl border border-line bg-surface p-7 ${CARD_SHADOW}`}>
            <div className="space-y-5">
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-muted">Department name</label>
                <input
                  className={inputClass}
                  value={name}
                  disabled={!isSuperAdmin}
                  onChange={(e) => setName(e.target.value)}
                />
                {!isSuperAdmin && (
                  <p className="mt-1.5 text-[12px] text-subtle">Only the Super Admin can rename a department.</p>
                )}
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-muted">ID prefix</label>
                <input
                  className={`${inputClass} font-mono uppercase`}
                  value={idPrefix}
                  maxLength={8}
                  onChange={(e) => setIdPrefix(e.target.value.toUpperCase())}
                />
                <p className="mt-1.5 text-[12px] text-subtle">
                  Used in new document IDs. Documents already issued keep the ID they have — IDs are
                  immutable.
                </p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-muted">
                    What this department manages
                  </label>
                  <input className={inputClass} value={subjectTerm} onChange={(e) => setSubjectTerm(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-muted">Primary identifier</label>
                  <input
                    className={inputClass}
                    value={identifierTerm}
                    onChange={(e) => setIdentifierTerm(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-muted">
                  Subfolder depth limit
                </label>
                <input
                  className={`${inputBase} w-full max-w-[220px]`}
                  type="number"
                  min={1}
                  max={20}
                  value={depthLimit}
                  placeholder="Organization default"
                  onChange={(e) => setDepthLimit(e.target.value)}
                />
                <p className="mt-1.5 text-[12px] text-subtle">
                  Leave empty to follow the organization default.
                </p>
              </div>
            </div>
            <button onClick={saveOverview} disabled={saving} className={`${primaryButtonBase} mt-7 px-7`}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        )}

        {activeTab === "Document types" && (
          <div>
            <DocumentTypeEditor value={documentTypes} onChange={setDocumentTypes} idPrefix={idPrefix} />
            <div className="mt-6 flex justify-end border-t border-line-muted pt-5">
              <button onClick={saveDocumentTypes} disabled={saving} className={`${primaryButtonBase} px-7`}>
                {saving ? "Saving…" : "Save document types"}
              </button>
            </div>
          </div>
        )}

        {activeTab === "Roles" && catalogue && (
          <div>
            <RoleMatrixEditor
              roles={roles}
              onChange={setRoles}
              groups={catalogue.groups}
              dependencies={catalogue.dependencies}
            />
            <div className="mt-6 flex justify-end border-t border-line-muted pt-5">
              <button onClick={saveRoles} disabled={saving} className={`${primaryButtonBase} px-7`}>
                {saving ? "Saving…" : "Save roles"}
              </button>
            </div>
          </div>
        )}

        {activeTab === "Rules" && (
          <div className="max-w-2xl">
            <RulesEditor value={rules} onChange={setRules} subjectTerm={department.subjectTerm} />
            <div className="mt-6 flex justify-end border-t border-line-muted pt-5">
              <button onClick={saveRules} disabled={saving} className={`${primaryButtonBase} px-7`}>
                {saving ? "Saving…" : "Save rules"}
              </button>
            </div>
          </div>
        )}

        {activeTab === "Retention" && (
          <RetentionPanel
            departmentId={departmentId}
            canManageAutoDelete={canManageAutoDelete}
            canViewUpcoming={canViewUpcoming}
            canManageHolds={canManageHolds}
          />
        )}

        {activeTab === "Members" && (
          <div className="max-w-3xl">
            <div className={`overflow-hidden rounded-2xl border border-line bg-surface ${CARD_SHADOW}`}>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-surface-muted">
                    <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                      Member
                    </th>
                    <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Role</th>
                    <th className="px-6 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {department.members.map((m) => (
                    <tr key={m.userId} className="border-b border-line-muted last:border-b-0">
                      <td className="px-6 py-4">
                        <span className="block text-[15px] font-medium text-ink">{m.fullName}</span>
                        <span className="block text-[13px] text-subtle">{m.email}</span>
                      </td>
                      <td className="px-6 py-4">
                        {canChangeRole ? (
                          <Select
                            ariaLabel={`Role for ${m.fullName}`}
                            className="w-56"
                            value={m.roleId}
                            // Grantable roles, plus the one they already hold so it still displays.
                            options={department.roles
                              .filter((r) => r.id === m.roleId || grantableRoles.some((g) => g.id === r.id))
                              .map(roleOption)}
                            onChange={(roleId) =>
                              run(async () => {
                                await apiRequest(`/departments/${departmentId}/members/${m.userId}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ roleId }),
                                });
                              }, `${m.fullName}'s role updated.`)
                            }
                          />
                        ) : (
                          <span className="text-[14px] text-muted">{m.roleName}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {canRemove && (
                          <button
                            aria-label={`Remove ${m.fullName}`}
                            onClick={() =>
                              run(async () => {
                                await apiRequest(`/departments/${departmentId}/members/${m.userId}`, {
                                  method: "DELETE",
                                });
                              }, `${m.fullName} removed from this department.`)
                            }
                            className="rounded-md p-2 text-subtle transition-colors hover:bg-danger-tint hover:text-danger"
                          >
                            <TrashIcon size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!canInvite && !canChangeRole && (
              <p className="mt-5 text-[13.5px] text-subtle">
                You can view this department's members. Adding or inviting people isn't part of your
                role here.
              </p>
            )}

            {canInvite && (
              <>
                <div className={`mt-5 rounded-2xl border border-line bg-surface p-6 ${CARD_SHADOW}`}>
                  <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                    <MailIcon size={17} className="text-subtle" /> Invite by email
              </h3>
              <p className="mt-1 text-[14px] text-muted">
                They get a link that expires in 7 days. If they already have an account, accepting
                just adds this department to it.
                {grantableRoles.length < department.roles.length &&
                  " You can offer roles with no more access than your own."}
              </p>
              <form
                className="mt-4 flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const roleId = inviteRoleId || grantableRoles[0]?.id;
                  if (!roleId) return;
                  void run(async () => {
                    await createInvitation(departmentId, { email: inviteEmail.trim(), roleId });
                    setInviteEmail("");
                    await refetchInvitations();
                  }, `Invitation sent to ${inviteEmail.trim()}.`);
                }}
              >
                <div className="min-w-[240px] flex-1">
                  <label className="mb-2 block text-[13.5px] font-medium text-ink">Email address</label>
                  <input
                    type="email"
                    required
                    className={inputClass}
                    value={inviteEmail}
                    placeholder="name@company.com"
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-2 block text-[13.5px] font-medium text-ink">Role</label>
                  <Select
                    ariaLabel="Role for the invited person"
                    className="w-56"
                    value={inviteRoleId || grantableRoles[0]?.id || ""}
                    options={grantableRoles.map(roleOption)}
                    onChange={setInviteRoleId}
                  />
                </div>
                <button type="submit" disabled={saving} className={`${primaryButtonBase} px-6`}>
                  Send invitation
                </button>
              </form>

              {invitations && invitations.length > 0 && (
                <div className="mt-6 border-t border-line-muted pt-5">
                  <h4 className="text-[14px] font-semibold text-ink">Pending invitations</h4>
                  <ul className="mt-3 space-y-2">
                    {invitations.map((invite) => (
                      <li
                        key={invite.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-muted bg-surface-muted px-4 py-3"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {invite.email}
                          </span>
                          <span className="block text-[13px] text-subtle">
                            {invite.roleName} · invited by {invite.invitedBy} ·{" "}
                            {invite.isExpired
                              ? "expired"
                              : `expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                          </span>
                        </span>
                        <span className="flex items-center gap-4">
                          <button
                            type="button"
                            onClick={() =>
                              run(async () => {
                                await resendInvitation(departmentId, invite.id);
                                await refetchInvitations();
                              }, `Invitation resent to ${invite.email}.`)
                            }
                            className="text-[13.5px] font-medium text-primary hover:underline"
                          >
                            Resend
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              run(async () => {
                                await revokeInvitation(departmentId, invite.id);
                                await refetchInvitations();
                              }, `Invitation to ${invite.email} revoked.`)
                            }
                            className="text-[13.5px] font-medium text-danger hover:underline"
                          >
                            Revoke
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className={`mt-5 rounded-2xl border border-line bg-surface p-6 ${CARD_SHADOW}`}>
              <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                <UsersIcon size={17} className="text-subtle" /> Add someone who already has an account
              </h3>
              {unassigned.length > 0 ? (
                <>
                  <p className="mt-1 text-[14px] text-muted">
                    {unassigned.length} {unassigned.length === 1 ? "person" : "people"} in the organization
                    {unassigned.length === 1 ? " isn't" : " aren't"} in this department yet. Search by name or email.
                  </p>
                  {/* Two steps on purpose: picking a role used to add the person immediately, so a
                      stray change event granted access with no confirming action. Choosing is just
                      choosing; "Add" commits. */}
                  <form
                    className="mt-4 flex flex-wrap items-end gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const person = unassigned.find((m) => m.userId === addUserId);
                      if (!person || !addRoleId) return;
                      void run(async () => {
                        await apiRequest(`/departments/${departmentId}/members`, {
                          method: "POST",
                          body: JSON.stringify({ userId: person.userId, roleId: addRoleId }),
                        });
                        setAddUserId("");
                        setAddRoleId("");
                      }, `${person.fullName} added to this department.`);
                    }}
                  >
                    <div className="min-w-[260px] flex-1">
                      <label className="mb-2 block text-[13.5px] font-medium text-ink">Person</label>
                      <SearchSelect
                        ariaLabel="Person to add"
                        className="w-full"
                        placeholder="Search for a person…"
                        searchPlaceholder="Search by name or email…"
                        value={addUserId}
                        options={unassigned.map((m) => ({ value: m.userId, label: m.fullName, hint: m.email }))}
                        onChange={setAddUserId}
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-[13.5px] font-medium text-ink">Role</label>
                      <Select
                        ariaLabel="Role for the person being added"
                        className="w-52"
                        placeholder="Choose a role…"
                        value={addRoleId}
                        options={grantableRoles.map(roleOption)}
                        onChange={setAddRoleId}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!addUserId || !addRoleId || saving}
                      className={`${primaryButtonBase} px-6 disabled:opacity-40`}
                    >
                      Add to department
                    </button>
                  </form>
                </>
              ) : (
                <p className="mt-3 text-[13.5px] text-subtle">
                  Everyone in the organization's directory already has a role here. New people are
                  added to the organization first, from the user directory.
                </p>
              )}
            </div>
              </>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
