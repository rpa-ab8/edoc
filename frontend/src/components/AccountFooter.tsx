import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { ChevronDownIcon, LogoutIcon } from "./icons";

function initials(name: string | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/**
 * The one place the account lives: name, email, organization switch and sign-out — constant across
 * every page, docked above nothing (it's the bottom of the rail). The organization switch appears
 * here and nowhere else, and only when the user actually belongs to more than one (bug 5); it
 * switches in place via a dropdown rather than sending the user off to a separate page (bug 6).
 * Signing out asks first (bug 6).
 */
export function AccountFooter() {
  const navigate = useNavigate();
  const { user, organizations, currentOrganizationId } = useAuthStore();
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [switching, setSwitching] = useState(false);

  const multiOrg = organizations.length > 1;

  async function switchOrg(id: string) {
    setOrgMenuOpen(false);
    if (id === currentOrganizationId) return;
    setSwitching(true);
    try {
      const result = await apiRequest<{ accessToken: string }>("/auth/select-organization", {
        method: "POST",
        body: JSON.stringify({ organizationId: id }),
      });
      useAuthStore.getState().setAccessToken(result.accessToken);
      useAuthStore.getState().selectOrganization(id);
      // Land on "/" — the previous URL may point into a department that doesn't exist in the new org.
      navigate("/");
    } finally {
      setSwitching(false);
    }
  }

  async function signOut() {
    await apiRequest("/auth/logout", { method: "POST" }).catch(() => {});
    useAuthStore.getState().clear();
    navigate("/login");
  }

  return (
    <div className="border-t border-rail-line px-4 py-4">
      {/* Organization switch — only when there's more than one to switch between */}
      {multiOrg && (
        <div className="relative mb-1.5">
          <button
            type="button"
            onClick={() => setOrgMenuOpen((v) => !v)}
            disabled={switching}
            aria-expanded={orgMenuOpen}
            className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-left text-[13.5px] font-medium text-rail-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
          >
            <span className="min-w-0">
              <span className="block text-[11px] uppercase tracking-[0.08em] text-rail-muted/70">Organization</span>
              <span className="block truncate text-rail-ink">{switching ? "Switching…" : currentOrg?.name}</span>
            </span>
            <ChevronDownIcon size={15} className={`shrink-0 ${orgMenuOpen ? "rotate-180" : ""}`} />
          </button>

          {orgMenuOpen && (
            <ul className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-card-lg">
              {organizations.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => void switchOrg(o.id)}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[14px] transition-colors hover:bg-surface-muted ${
                      o.id === currentOrganizationId ? "font-semibold text-primary" : "text-ink"
                    }`}
                  >
                    <span className="truncate">{o.name}</span>
                    {o.isSuperAdmin && <span className="text-[11px] font-medium text-subtle">Owner</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {confirmingLogout ? (
        <div className="rounded-xl bg-rail-raised px-3 py-3">
          <p className="mb-2.5 text-[13px] text-rail-ink">Sign out of your account?</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex-1 rounded-lg bg-danger px-3 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              Sign out
            </button>
            <button
              type="button"
              onClick={() => setConfirmingLogout(false)}
              className="flex-1 rounded-lg bg-rail-line px-3 py-2 text-[13px] font-medium text-rail-ink transition-colors hover:bg-rail-line/70"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-rail-raised px-3 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-white">
              {initials(user?.fullName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-medium text-rail-ink">{user?.fullName}</p>
              <p className="truncate text-[12.5px] text-rail-muted">{user?.email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setConfirmingLogout(true)}
            title="Sign out"
            aria-label="Sign out"
            className="shrink-0 rounded-md p-2 text-rail-muted transition-colors hover:bg-rail-line hover:text-rail-ink"
          >
            <LogoutIcon size={17} />
          </button>
        </div>
      )}
    </div>
  );
}
