import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { Logomark } from "./AuthCard";
import { AccountFooter } from "./AccountFooter";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GearIcon,
  GridIcon,
  HoldIcon,
  LockIcon,
  PlusIcon,
  UsersIcon,
} from "./icons";
import type { FolderNode } from "../lib/folders";
import type { DepartmentSummary } from "../lib/departments";
import type { PermissionMap } from "../lib/departments";
import type { QuickView } from "../lib/search";

// Recent and "Uploaded by me" are live (Module 7). "Shared with me/by me" render in the same
// main-panel list (Module 9) and span every department. "Trash" (Module 11) shows the department's
// trash in the same panel. They all draw from their own APIs but present in one place.
const QUICK_VIEWS: { label: string; view?: QuickView }[] = [
  { label: "Recent", view: "recent" },
  { label: "Uploaded by me", view: "uploaded_by_me" },
  { label: "Shared with me", view: "shared_with_me" },
  { label: "Shared by me", view: "shared_by_me" },
  { label: "Trash", view: "trash" },
];

export function WorkspaceShell({
  department,
  departments,
  folders,
  currentFolderId,
  permissions,
  roleName = null,
  onCreateFolder,
  activeQuickView = null,
  onQuickView,
  children,
}: {
  department: DepartmentSummary;
  departments: DepartmentSummary[];
  folders: FolderNode[];
  currentFolderId: string | null;
  permissions: PermissionMap;
  /** The viewer's role name in this department, shown so they always know their standing (bug 7). */
  roleName?: string | null;
  onCreateFolder: (parentFolderId: string | null) => void;
  activeQuickView?: QuickView | null;
  onQuickView?: (view: QuickView) => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { user, organizations, currentOrganizationId } = useAuthStore();
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const canCreateFolder = permissions["folders.create"] === true;
  const canConfigure =
    permissions["configuration.edit_metadata_schema"] === true || currentOrg?.isSuperAdmin === true;
  // A role that can bring people in (a manager with members.invite) needs the Members page even
  // though it can't configure the department — otherwise its permission has no screen.
  const canManageMembers =
    permissions["members.invite"] === true ||
    permissions["members.change_role"] === true ||
    permissions["members.remove"] === true;

  const roots = folders.filter((f) => f.parentFolderId === null);
  const childrenOf = (id: string) => folders.filter((f) => f.parentFolderId === id);

  function FolderBranch({ folder }: { folder: FolderNode }) {
    const kids = childrenOf(folder.id);
    const isOpen = expanded.has(folder.id);
    const isCurrent = currentFolderId === folder.id;
    return (
      <li>
        <div
          className={`group flex items-center gap-1 rounded-lg pr-2 transition-colors ${
            isCurrent ? "bg-primary-tint" : "hover:bg-rail-raised"
          }`}
          style={{ paddingLeft: `${folder.depth * 12}px` }}
        >
          <button
            type="button"
            aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              })
            }
            className={`shrink-0 rounded p-1 ${kids.length > 0 ? "text-rail-muted hover:text-rail-ink" : "invisible"}`}
          >
            <ChevronRightIcon size={13} className={isOpen ? "rotate-90 transition-transform" : "transition-transform"} />
          </button>
          <Link
            to={`/w/${department.id}/f/${folder.id}`}
            className={`flex min-w-0 flex-1 items-center gap-2 py-2 text-[14px] ${
              isCurrent ? "font-medium text-primary" : "text-rail-muted hover:text-rail-ink"
            }`}
          >
            <span className="truncate">{folder.name}</span>
            {folder.isConfidential && (
              <span title="Confidential — named members only" className="shrink-0 text-accent">
                <LockIcon size={13} />
              </span>
            )}
            {folder.legalHold === "held" && (
              <span title="Legal Hold — nothing in this folder can be deleted" className="shrink-0 text-warning-tint">
                <HoldIcon size={13} />
              </span>
            )}
          </Link>
        </div>
        {isOpen && kids.length > 0 && (
          <ul>
            {kids.map((child) => (
              <FolderBranch key={child.id} folder={child} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto bg-rail">
        <div className="flex items-center gap-3 px-5 py-5">
          <Logomark size={38} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-rail-ink">{currentOrg?.name}</p>
            <p className="truncate text-[12.5px] text-rail-muted">{user?.fullName}</p>
          </div>
        </div>

        {/* The department you're in, and the way out of it. A single-department user gets a
            label rather than a control that only ever leads back to where they already are. */}
        <div className="relative px-4 pb-2">
          <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-rail-muted">
            Department
          </p>
          <button
            type="button"
            onClick={() => departments.length > 1 && setSwitcherOpen((v) => !v)}
            aria-expanded={switcherOpen}
            className={`flex w-full items-center gap-2.5 rounded-xl bg-rail-raised px-3.5 py-3 text-left ${
              departments.length > 1 ? "hover:bg-rail-line" : "cursor-default"
            }`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
              <FolderIcon size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-semibold text-rail-ink">
                {department.name}
              </span>
              <span className="block font-mono text-[11.5px] text-rail-muted">{department.idPrefix}</span>
            </span>
            {departments.length > 1 && (
              <ChevronDownIcon size={15} className={`shrink-0 text-rail-muted ${switcherOpen ? "rotate-180" : ""}`} />
            )}
          </button>

          {/* Your standing in this department — so a user always knows what they can do here (bug 7). */}
          <p className="mt-1.5 px-1 text-[12px] text-rail-muted">
            {roleName ? (
              <>Your role: <span className="font-medium text-rail-ink">{roleName}</span></>
            ) : currentOrg?.isSuperAdmin ? (
              "Organization owner (no role here)"
            ) : (
              "No role in this department"
            )}
          </p>

          {switcherOpen && (
            <ul className="absolute left-4 right-4 z-20 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-card-lg">
              {departments.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSwitcherOpen(false);
                      navigate(`/w/${d.id}`);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[14px] transition-colors hover:bg-surface-muted ${
                      d.id === department.id ? "font-semibold text-primary" : "text-ink"
                    }`}
                  >
                    <span className="truncate">{d.name}</span>
                    <span className="font-mono text-[11.5px] text-subtle">{d.idPrefix}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-2">
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-rail-muted">
            Views
          </p>
          <ul>
            {QUICK_VIEWS.map((qv) => {
              // A view filters/loads in the main panel; anything not yet built (Trash) stays inert
              // rather than pretending to work.
              const clickable = Boolean(qv.view) && Boolean(onQuickView);
              if (!clickable) {
                return (
                  <li
                    key={qv.label}
                    aria-disabled="true"
                    title="Arrives with trash"
                    className="cursor-not-allowed rounded-lg px-3 py-2 text-[14px] text-rail-muted/40"
                  >
                    {qv.label}
                  </li>
                );
              }
              const isActive = activeQuickView === qv.view;
              return (
                <li key={qv.label}>
                  <button
                    type="button"
                    onClick={() => onQuickView!(qv.view!)}
                    className={`w-full rounded-lg px-3 py-2 text-left text-[14px] transition-colors ${
                      isActive ? "bg-primary-tint font-medium text-primary" : "text-rail-muted hover:bg-rail-raised hover:text-rail-ink"
                    }`}
                  >
                    {qv.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex-1 px-4 py-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-rail-muted">Folders</p>
            {canCreateFolder && (
              <button
                type="button"
                onClick={() => onCreateFolder(null)}
                aria-label="New folder"
                className="rounded p-1 text-rail-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
              >
                <PlusIcon size={15} />
              </button>
            )}
          </div>
          {roots.length > 0 ? (
            <ul>
              {roots.map((folder) => (
                <FolderBranch key={folder.id} folder={folder} />
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[13px] text-rail-muted/70">
              {canCreateFolder ? "No folders yet." : "No folders you can see."}
            </p>
          )}
        </div>

        <div className="mt-auto border-t border-rail-line px-4 py-3">
          {canConfigure ? (
            <Link
              to={`/departments/${department.id}`}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium text-rail-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
            >
              <GearIcon size={17} /> Department settings
            </Link>
          ) : (
            canManageMembers && (
              <Link
                to={`/departments/${department.id}`}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium text-rail-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
              >
                <UsersIcon size={17} /> Members
              </Link>
            )
          )}
          {currentOrg?.isSuperAdmin && (
            <>
              <Link
                to="/departments"
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium text-rail-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
              >
                <FolderIcon size={17} /> All departments
              </Link>
              <Link
                to="/"
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium text-rail-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
              >
                <GridIcon size={17} /> Organization overview
              </Link>
            </>
          )}
        </div>

        <AccountFooter />
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-canvas">{children}</main>
    </div>
  );
}
