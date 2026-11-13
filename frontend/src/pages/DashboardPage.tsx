import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { AppShell } from "../components/AppShell";
import { primaryButtonBase } from "../components/AuthCard";
import {
  ChevronRightIcon,
  DatabaseIcon,
  DocumentIcon,
  FolderIcon,
  GearIcon,
  PlusIcon,
  UsersIcon,
} from "../components/icons";

interface HealthResponse {
  status: string;
  timestamp: string;
}

interface StorageStatus {
  backendType: "nas" | "r2";
  status: "pending" | "verified" | "error";
  lastTestedAt: string | null;
}

interface DepartmentSummary {
  id: string;
  name: string;
  memberCount: number;
  documentCount: number;
}

interface DashboardSummary {
  counts: {
    departments: number;
    users: number;
    documents: number;
    storageUsedBytes: string;
  };
  storage: StorageStatus | null;
  departments: DepartmentSummary[];
}

function formatBytes(raw: string): string {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const STORAGE_NAME = { nas: "Network storage (NAS)", r2: "Cloudflare R2" } as const;

const STORAGE_STATUS = {
  verified: { label: "Connected", className: "bg-success-tint text-success", dot: "bg-success" },
  pending: { label: "Not tested yet", className: "bg-warning-tint text-warning", dot: "bg-warning" },
  error: { label: "Connection failed", className: "bg-danger-tint text-danger", dot: "bg-danger" },
} as const;

const CARD = "rounded-2xl border border-line bg-surface shadow-card";

/** A row in the "Manage" card: icon tile, title, one line saying what's behind it. */
function ManageLink({ to, icon, title, hint }: { to: string; icon: ReactNode; title: string; hint: string }) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3.5 rounded-xl px-3 py-3 transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted transition-colors group-hover:bg-primary-tint group-hover:text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-ink">{title}</span>
        <span className="block truncate text-[13.5px] text-subtle">{hint}</span>
      </span>
      <ChevronRightIcon size={16} className="shrink-0 text-subtle transition-colors group-hover:text-primary" />
    </Link>
  );
}

export function DashboardPage() {
  const { organizations, currentOrganizationId } = useAuthStore();
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
  const isSuperAdmin = currentOrg?.isSuperAdmin ?? false;

  const { data: health, isError: healthFailed } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiRequest<HealthResponse>("/health"),
  });

  const { data: dashboard } = useQuery({
    queryKey: ["org-dashboard"],
    queryFn: () => apiRequest<DashboardSummary>("/organizations/current/dashboard"),
    enabled: isSuperAdmin,
  });

  const stats = [
    {
      label: "Departments",
      value: dashboard?.counts.departments,
      sub: dashboard && dashboard.counts.departments === 0 ? "None created yet" : "Active",
      icon: <FolderIcon size={16} />,
    },
    {
      label: "Users",
      value: dashboard?.counts.users,
      sub: "Active accounts",
      icon: <UsersIcon size={16} />,
    },
    {
      label: "Documents",
      value: dashboard?.counts.documents,
      sub: dashboard && dashboard.counts.documents === 0 ? "None uploaded yet" : "Across all departments",
      icon: <DocumentIcon size={16} />,
    },
    {
      label: "Storage used",
      value: dashboard ? formatBytes(dashboard.counts.storageUsedBytes) : undefined,
      sub: "Total stored",
      icon: <DatabaseIcon size={16} />,
    },
  ];

  const departments = dashboard?.departments ?? [];
  const hasDepartments = departments.length > 0;
  // The bar beside each document count is relative to the busiest department, so the list can be
  // compared at a glance. It is a comparison, not a quota.
  const maxDocuments = Math.max(1, ...departments.map((d) => d.documentCount));
  const storage = dashboard?.storage ?? null;
  const storageStatus = storage ? STORAGE_STATUS[storage.status] : null;

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] text-muted">Organization overview</p>
          <h1 className="mt-1 truncate text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
            {currentOrg?.name}
          </h1>
        </div>
        {isSuperAdmin && hasDepartments && (
          <Link to="/departments/new" className={`${primaryButtonBase} flex shrink-0 items-center gap-2`}>
            <PlusIcon size={16} /> New department
          </Link>
        )}
      </div>

      {isSuperAdmin ? (
        <>
          {/* One band, four figures. A single surface with hairline dividers reads as one summary;
              four separate cards with coloured icon discs read as four unrelated widgets. */}
          <dl className={`mt-8 grid grid-cols-2 overflow-hidden lg:grid-cols-4 ${CARD}`}>
            {stats.map((stat, i) => (
              <div
                key={stat.label}
                className={`border-line-muted px-6 py-6 ${i % 2 === 1 ? "border-l" : ""} ${
                  i >= 2 ? "border-t lg:border-t-0" : ""
                } ${i === 2 ? "lg:border-l" : ""}`}
              >
                <dt className="flex items-center gap-2 text-[13.5px] font-medium text-muted">
                  <span className="text-subtle">{stat.icon}</span>
                  {stat.label}
                </dt>
                <dd className="mt-3.5 text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">
                  {stat.value ?? <span className="text-line">—</span>}
                </dd>
                <dd className="mt-2.5 text-[13.5px] text-subtle">{stat.sub}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className={`overflow-hidden ${CARD}`}>
              <div className="flex items-center justify-between gap-4 px-6 py-5">
                <div>
                  <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-ink">Departments</h2>
                  {hasDepartments && (
                    <p className="mt-0.5 text-[13.5px] text-subtle">Open one to manage its people, types and rules.</p>
                  )}
                </div>
                {hasDepartments && (
                  <Link
                    to="/departments"
                    className="flex shrink-0 items-center gap-1 text-[14px] font-medium text-primary transition-colors hover:text-primary-dark"
                  >
                    View all <ChevronRightIcon size={15} />
                  </Link>
                )}
              </div>

              {hasDepartments ? (
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-y border-line-muted bg-surface-muted/70">
                      <th className="px-6 py-3 text-[13px] font-medium text-subtle">Department</th>
                      <th className="w-28 px-4 py-3 text-right text-[13px] font-medium text-subtle">Members</th>
                      <th className="w-56 px-4 py-3 text-[13px] font-medium text-subtle">Documents</th>
                      <th className="w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    {departments.map((d) => (
                      <tr
                        key={d.id}
                        className="group border-b border-line-muted transition-colors last:border-b-0 hover:bg-surface-muted/50"
                      >
                        <td className="px-6 py-3.5">
                          <Link
                            to={`/departments/${d.id}`}
                            className="flex items-center gap-3.5 text-[15px] font-medium text-ink group-hover:text-primary"
                          >
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
                              <FolderIcon size={18} />
                            </span>
                            <span className="truncate">{d.name}</span>
                          </Link>
                        </td>
                        <td className="px-4 py-3.5 text-right text-[15px] tabular-nums text-muted">{d.memberCount}</td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="w-12 text-[15px] tabular-nums text-ink">{d.documentCount}</span>
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                              <span
                                className="block h-full rounded-full bg-primary/70"
                                style={{ width: `${(d.documentCount / maxDocuments) * 100}%` }}
                              />
                            </span>
                          </div>
                        </td>
                        <td className="pr-5 text-right">
                          <Link
                            to={`/departments/${d.id}`}
                            aria-label={`Open ${d.name}`}
                            className="inline-flex rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-muted group-hover:text-primary"
                          >
                            <ChevronRightIcon size={16} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex flex-col items-center border-t border-line-muted px-6 py-16 text-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-tint text-primary">
                    <FolderIcon size={24} />
                  </span>
                  <p className="mt-5 text-[17px] font-semibold text-ink">
                    {dashboard ? "Create your first department" : "Loading departments…"}
                  </p>
                  {dashboard && (
                    <>
                      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">
                        A department holds its own document types, fields and roles. Start from a
                        template and adjust it.
                      </p>
                      <Link to="/departments/new" className={`${primaryButtonBase} mt-6 flex items-center gap-2`}>
                        <PlusIcon size={16} /> New department
                      </Link>
                    </>
                  )}
                </div>
              )}
            </section>

            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-1">
              <section className={`p-6 ${CARD}`}>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[17px] font-semibold text-ink">Storage</h2>
                  {storageStatus && (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium ${storageStatus.className}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${storageStatus.dot}`} />
                      {storageStatus.label}
                    </span>
                  )}
                </div>

                {storage ? (
                  <>
                    <div className="mt-5 flex items-center gap-3.5">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-muted">
                        <DatabaseIcon size={20} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-medium text-ink">{STORAGE_NAME[storage.backendType]}</p>
                        <p className="text-[13.5px] text-subtle">
                          {storage.lastTestedAt ? `Last checked ${formatDate(storage.lastTestedAt)}` : "Not checked yet"}
                        </p>
                      </div>
                    </div>
                    {/* No usage bar: there is no quota to measure against, and a bar pinned at
                        100% read as "storage full" with a few KB stored. */}
                    <dl className="mt-5 flex items-baseline justify-between border-t border-line-muted pt-4">
                      <dt className="text-[13.5px] text-subtle">Stored in total</dt>
                      <dd className="text-[15px] font-medium tabular-nums text-ink">
                        {dashboard ? formatBytes(dashboard.counts.storageUsedBytes) : "—"}
                      </dd>
                    </dl>
                  </>
                ) : (
                  <p className="mt-4 text-[15px] leading-relaxed text-muted">
                    {dashboard
                      ? "No storage is connected yet."
                      : "Loading…"}
                  </p>
                )}

                <Link
                  to="/storage-setup"
                  className="mt-5 flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-[14.5px] font-medium text-ink shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-colors hover:border-[#CDD3CF] hover:bg-surface-muted"
                >
                  {storage ? "Manage storage" : "Connect storage"}
                </Link>
              </section>

              <section className={`p-3 ${CARD}`}>
                <h2 className="px-3 pb-1 pt-3 text-[17px] font-semibold text-ink">Manage</h2>
                <ManageLink
                  to="/user-directory"
                  icon={<UsersIcon size={18} />}
                  title="Users"
                  hint="Invite people and see who has access"
                />
                <ManageLink
                  to="/organization-settings"
                  icon={<GearIcon size={18} />}
                  title="Organization settings"
                  hint="Name, industry, time zone and folder depth"
                />
              </section>
            </div>
          </div>
        </>
      ) : (
        <p className="mt-8 max-w-xl text-[15px] leading-relaxed text-muted">
          This page is for the organization's Super Admin. Use the link in the sidebar to go back to
          your department.
        </p>
      )}

      <p className="mt-8 flex items-center gap-2 text-[13.5px] text-subtle" role="status">
        <span
          className={`h-2 w-2 rounded-full ${health ? "bg-success" : healthFailed ? "bg-danger" : "bg-line"}`}
          aria-hidden="true"
        />
        {health ? "All systems running" : healthFailed ? "Can't reach the server" : "Checking the server…"}
      </p>
    </AppShell>
  );
}
