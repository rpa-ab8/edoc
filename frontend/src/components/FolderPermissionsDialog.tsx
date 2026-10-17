import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { primaryButtonBase, secondaryButtonBase } from "./AuthCard";
import { Select } from "./Select";
import { LockIcon, XIcon } from "./icons";
import { ApiRequestError } from "../lib/api";
import { fetchPermissionCatalogue } from "../lib/departments";
import { fetchFolderPermissions, setFolderPermission, type FolderRolePermission } from "../lib/folders";

/**
 * Break inheritance on a folder: pick a role and untick permissions to *restrict* it here. You can
 * only take away — the checklist shows only what the role already grants, and unticking withholds it
 * on this folder and everything under it. Ticking everything back on (or "Reset") clears the override.
 */
export function FolderPermissionsDialog({
  departmentId,
  folderId,
  onClose,
}: {
  departmentId: string;
  folderId: string;
  onClose: () => void;
}) {
  const [roleId, setRoleId] = useState("");
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ["folder-permissions", folderId],
    queryFn: () => fetchFolderPermissions(departmentId, folderId),
    retry: false,
  });
  const { data: catalogue } = useQuery({
    queryKey: ["permission-catalogue"],
    queryFn: fetchPermissionCatalogue,
    retry: false,
  });

  const roles = data?.roles ?? [];
  const role: FolderRolePermission | undefined = roles.find((r) => r.roleId === roleId);

  // Reverse dependency map (parent → its dependents), so restricting a parent cascades to children.
  const dependents = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const [child, parents] of Object.entries(catalogue?.dependencies ?? {})) {
      for (const parent of parents) (map[parent] ??= []).push(child);
    }
    return map;
  }, [catalogue]);

  // The keys this role actually grants — the only keys that can be restricted.
  const grantedKeys = useMemo(
    () => (role ? Object.keys(role.basePermissions).filter((k) => role.basePermissions[k]) : []),
    [role],
  );

  // When a role is selected, seed the checklist: granted keys, minus the ones already restricted.
  useEffect(() => {
    if (!role) return;
    const restricted = new Set(role.restrictedKeys);
    setAllowed(new Set(grantedKeys.filter((k) => !restricted.has(k))));
    setMessage(null);
  }, [role, grantedKeys]);

  function toggle(key: string, on: boolean) {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(key);
        // Re-allowing a child means its parents must be allowed too (can't download without view).
        for (const [child, parents] of Object.entries(catalogue?.dependencies ?? {})) {
          if (child === key) for (const p of parents) if (grantedKeys.includes(p)) next.add(p);
        }
      } else {
        next.delete(key);
        // Restricting a parent cascades to everything that depends on it.
        const stack = [key];
        while (stack.length) {
          const k = stack.pop()!;
          for (const dep of dependents[k] ?? []) {
            if (next.delete(dep)) stack.push(dep);
          }
        }
      }
      return next;
    });
  }

  async function save() {
    if (!role) return;
    setBusy(true);
    setMessage(null);
    try {
      const restrict = grantedKeys.filter((k) => !allowed.has(k));
      await setFolderPermission(departmentId, folderId, role.roleId, restrict);
      await refetch();
      setMessage({ text: restrict.length ? "Access restricted on this folder." : "Override cleared — inherits again.", ok: true });
    } catch (err) {
      setMessage({ text: err instanceof ApiRequestError ? err.message : "Couldn't save.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  const label = (key: string) => {
    for (const g of catalogue?.groups ?? []) {
      const p = g.permissions.find((x) => x.key === key);
      if (p) return p.label;
    }
    return key;
  };

  // Group the role's granted keys under the catalogue's group headings for a scannable list.
  const grouped = (catalogue?.groups ?? [])
    .map((g) => ({ label: g.label, keys: g.permissions.map((p) => p.key).filter((k) => grantedKeys.includes(k)) }))
    .filter((g) => g.keys.length > 0);

  const restrictedCount = grantedKeys.filter((k) => !allowed.has(k)).length;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div className="w-full max-w-lg animate-card-in rounded-2xl border border-line bg-surface shadow-card-lg" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <LockIcon size={20} />
            </span>
            <div>
              <h2 className="text-[17px] font-bold tracking-[-0.3px] text-ink">Folder access</h2>
              <p className="truncate text-[13px] text-subtle">{data?.folderName} · restrict a role here</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-subtle hover:bg-surface-muted hover:text-ink">
            <XIcon size={16} />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Role</label>
          <Select
            value={roleId}
            onChange={setRoleId}
            placeholder="Choose a role to restrict…"
            ariaLabel="Role"
            options={roles.map((r) => ({
              value: r.roleId,
              label: r.roleName,
              hint: r.hasOverride ? "Has an override on this folder" : "Inherits",
            }))}
          />

          {role && (
            <>
              <p className="mt-4 text-[12.5px] text-subtle">
                Untick to withhold on this folder (and everything under it). You can only take away.
              </p>
              <div className="mt-3 space-y-4">
                {grouped.map((g) => (
                  <div key={g.label}>
                    <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-subtle">{g.label}</h4>
                    <div className="space-y-1.5">
                      {g.keys.map((key) => (
                        <label key={key} className="flex items-center gap-2.5 text-[13.5px] text-ink">
                          <input
                            type="checkbox"
                            checked={allowed.has(key)}
                            onChange={(e) => toggle(key, e.target.checked)}
                            className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
                          />
                          {label(key)}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex items-center gap-2.5">
                <button type="button" disabled={busy} onClick={save} className={`${primaryButtonBase} px-5`}>
                  {busy ? "Saving…" : restrictedCount ? `Restrict ${restrictedCount}` : "Clear override"}
                </button>
                {role.hasOverride && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAllowed(new Set(grantedKeys));
                      void save();
                    }}
                    className={`${secondaryButtonBase} px-5`}
                  >
                    Reset to inherited
                  </button>
                )}
              </div>
              {message && <p className={`mt-3 text-[13px] ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
