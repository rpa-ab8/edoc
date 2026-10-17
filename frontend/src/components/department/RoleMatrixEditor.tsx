import { Fragment, useState } from "react";
import {
  withDependencies,
  withDependentsCleared,
  type DraftRole,
  type PermissionGroup,
} from "../../lib/departments";
import { inputBase } from "../AuthCard";
import { PlusIcon, ShieldIcon, TrashIcon } from "../icons";

// Kept in step with the server's DEPARTMENT_ADMIN_CAPABILITY_KEYS (backend/src/lib/permissions.ts).
// If that definition changes, change it here too — the label shown to the admin and the rule the
// server enforces must agree.
const ADMIN_CAPABILITY_KEYS = ["members.change_role", "configuration.edit_rules"];

export function isDepartmentAdminRole(role: DraftRole): boolean {
  return ADMIN_CAPABILITY_KEYS.every((k) => role.permissions[k] === true);
}

export function RoleMatrixEditor({
  roles,
  onChange,
  groups,
  dependencies,
}: {
  roles: DraftRole[];
  onChange: (next: DraftRole[]) => void;
  groups: PermissionGroup[];
  dependencies: Record<string, string[]>;
}) {
  const [copyingFrom, setCopyingFrom] = useState<number | null>(null);
  const [copyName, setCopyName] = useState("");

  function toggle(roleIndex: number, key: string) {
    onChange(
      roles.map((role, i) => {
        if (i !== roleIndex) return role;
        const currently = role.permissions[key] === true;
        const permissions = currently
          ? withDependentsCleared(role.permissions, dependencies, key)
          : withDependencies({ ...role.permissions, [key]: true }, dependencies);
        return { ...role, permissions };
      }),
    );
  }

  const adminRoleCount = roles.filter(isDepartmentAdminRole).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {roles.map((role, index) => (
          <span
            key={index}
            className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-3 pr-1.5 text-[13px]"
          >
            <input
              value={role.name}
              onChange={(e) => onChange(roles.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
              disabled={role.isSystem}
              size={Math.max(role.name.length, 6)}
              className="bg-transparent font-medium text-ink outline-none disabled:text-muted"
            />
            {isDepartmentAdminRole(role) && (
              <span title="Can administer this department" className="text-primary">
                <ShieldIcon size={14} />
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setCopyingFrom(index);
                setCopyName(`${role.name} copy`);
              }}
              className="rounded-full px-2 py-0.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary-tint"
            >
              Copy
            </button>
            {!role.isSystem && (
              <button
                type="button"
                aria-label={`Remove ${role.name}`}
                onClick={() => onChange(roles.filter((_, i) => i !== index))}
                disabled={isDepartmentAdminRole(role) && adminRoleCount <= 1}
                className="rounded-full p-1 text-subtle transition-colors hover:bg-danger-tint hover:text-danger disabled:opacity-30"
              >
                <TrashIcon size={13} />
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          onClick={() => {
            const base = roles[0]?.permissions ?? {};
            onChange([
              ...roles,
              {
                name: `Role ${roles.length + 1}`,
                isSystem: false,
                permissions: Object.fromEntries(Object.keys(base).map((k) => [k, false])),
              },
            ]);
          }}
          className="flex items-center gap-1.5 rounded-full border border-dashed border-line px-3.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-primary"
        >
          <PlusIcon size={13} /> Add role
        </button>
      </div>

      {copyingFrom !== null && roles[copyingFrom] && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-primary/30 bg-primary-tint px-4 py-3">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted">
              Copy of {roles[copyingFrom].name}
            </label>
            <input className={`${inputBase} w-64`} value={copyName} onChange={(e) => setCopyName(e.target.value)} />
          </div>
          <button
            type="button"
            onClick={() => {
              const source = roles[copyingFrom];
              if (!source || !copyName.trim()) return;
              // A copy is never a system role — the built-ins are undeletable because they are
              // the floor a department can't fall below; a duplicate of one isn't.
              onChange([...roles, { name: copyName.trim(), isSystem: false, permissions: { ...source.permissions } }]);
              setCopyingFrom(null);
            }}
            className="rounded-lg bg-primary px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            Create copy
          </button>
          <button
            type="button"
            onClick={() => setCopyingFrom(null)}
            className="rounded-lg px-3 py-2.5 text-[13px] font-medium text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              <th className="sticky left-0 z-10 bg-surface-muted px-5 py-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                Permission
              </th>
              {roles.map((role, index) => (
                <th
                  key={index}
                  className="px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle"
                >
                  {role.name || "—"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.key}>
                <tr className="bg-surface-muted/60">
                  <td
                    colSpan={roles.length + 1}
                    className="px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted"
                  >
                    {group.label}
                  </td>
                </tr>
                {group.permissions.map((permission) => (
                  <tr key={permission.key} className="border-b border-line-muted last:border-b-0">
                    <td className="sticky left-0 z-10 bg-surface px-5 py-2.5 text-[13.5px] text-ink">
                      {permission.label}
                      {permission.inactiveInR1 && (
                        <span className="ml-2 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-subtle">
                          Release 2
                        </span>
                      )}
                      {dependencies[permission.key] && (
                        <span className="ml-2 text-[11.5px] text-subtle">
                          needs {dependencies[permission.key]!.map((d) => d.split(".")[1]).join(", ")}
                        </span>
                      )}
                    </td>
                    {roles.map((role, roleIndex) => (
                      <td key={roleIndex} className="px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${permission.label} for ${role.name}`}
                          className="h-4 w-4 accent-primary disabled:opacity-40"
                          checked={role.permissions[permission.key] === true}
                          disabled={permission.inactiveInR1}
                          onChange={() => toggle(roleIndex, permission.key)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 flex items-start gap-2 text-[13px] text-subtle">
        <ShieldIcon size={15} className="mt-px shrink-0 text-primary" />
        The shield marks a role that can administer this department. At least one role must keep
        it — otherwise nobody could manage members or configuration. Ticking a permission
        automatically ticks the ones it depends on.
      </p>
    </div>
  );
}
