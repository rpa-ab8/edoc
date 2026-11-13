import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { Logomark } from "./AuthCard";
import { ChevronLeftIcon, FolderIcon, GridIcon, UsersIcon } from "./icons";
import { AccountFooter } from "./AccountFooter";

// Atmosphere, not decoration: two soft washes and a barely-there grid that fades out well before
// it reaches the content column. Everything here sits far below text contrast — the earlier
// version put hard-edged shapes and a 12%-opacity dot grid directly behind body copy, which is a
// large part of why small text read as blurry.
/**
 * The organization-level chrome. Its nav is built from who the viewer is: a Super Admin owns the
 * organization and gets Overview + Departments, while a department admin who arrived here from
 * their own workspace gets a way back to it and nothing else — the earlier version showed everyone
 * the Super Admin's nav, which sent department admins to a screen they can't use and stranded them
 * there.
 */
export function AppShell({
  children,
  backTo,
}: {
  children: ReactNode;
  /** Where "back" leads for someone who isn't the Super Admin — usually their workspace. */
  backTo?: { label: string; to: string };
}) {
  const location = useLocation();
  const { organizations, currentOrganizationId } = useAuthStore();
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
  const isSuperAdmin = currentOrg?.isSuperAdmin ?? false;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-72 shrink-0 flex-col bg-rail rail-surface">
        <div className="flex items-center gap-3 border-b border-rail-line px-6 py-6">
          <Logomark size={42} />
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold tracking-[-0.2px] text-rail-ink">
              {currentOrg?.name}
            </p>
            {isSuperAdmin && (
              <span className="mt-1.5 inline-flex items-center rounded-md bg-rail-raised px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-rail-muted">
                Super Admin
              </span>
            )}
          </div>
        </div>

        {/* Only genuine top-level destinations live here — settings-type screens stay reachable
            from Overview's own panels rather than being duplicated in the sidebar. */}
        <nav className="flex-1 space-y-1.5 px-4 pt-6">
          {(isSuperAdmin
            ? [
                { to: "/", label: "Overview", icon: <GridIcon size={19} />, exact: true },
                { to: "/departments", label: "Departments", icon: <FolderIcon size={19} />, exact: false },
                { to: "/shares", label: "Shares", icon: <UsersIcon size={19} />, exact: false },
              ]
            : backTo
              ? [{ to: backTo.to, label: backTo.label, icon: <ChevronLeftIcon size={19} />, exact: false }]
              : []
          ).map((item) => {
            const active = item.exact
              ? location.pathname === item.to
              : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`relative flex items-center gap-3 overflow-hidden rounded-xl px-4 py-3 text-[15px] font-medium transition-colors ${
                  active
                    ? "bg-rail-raised text-rail-ink"
                    : "text-rail-muted hover:bg-rail-raised/60 hover:text-rail-ink"
                }`}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-[3px] bg-primary"
                  />
                )}
                {item.icon}
                {item.label}
              </Link>
            );
          })}
        </nav>

        <AccountFooter />
      </aside>

      <main className="relative min-w-0 flex-1 overflow-y-auto bg-canvas">
        <div className="relative mx-auto max-w-[1500px] px-8 py-9 sm:px-10 lg:px-12">{children}</div>
      </main>
    </div>
  );
}
