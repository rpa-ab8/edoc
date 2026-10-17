import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { AppShell } from "../components/AppShell";
import {
  BoltIcon,
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

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: undefined, year: "numeric", month: "short", day: "numeric" });
}

const CARD_SHADOW = "shadow-card";

export function DashboardPage() {
  const { organizations, currentOrganizationId } = useAuthStore();
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
  const isSuperAdmin = currentOrg?.isSuperAdmin ?? false;

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiRequest<HealthResponse>("/health"),
  });

  const { data: dashboard } = useQuery({
    queryKey: ["org-dashboard"],
    queryFn: () => apiRequest<DashboardSummary>("/organizations/current/dashboard"),
    enabled: isSuperAdmin,
  });

  const tiles = [
    {
      label: "Departments",
      value: dashboard?.counts.departments,
      sub: dashboard && dashboard.counts.departments === 0 ? "No departments yet" : "Active departments",
      icon: <FolderIcon size={18} />,
      tone: "primary" as const,
    },
    {
      label: "Users",
      value: dashboard?.counts.users,
      sub: "Active users",
      icon: <UsersIcon size={18} />,
      tone: "success" as const,
    },
    {
      label: "Documents",
      value: dashboard?.counts.documents,
      sub: dashboard && dashboard.counts.documents === 0 ? "No documents" : "Stored documents",
      icon: <DocumentIcon size={18} />,
      tone: "info" as const,
    },
    {
      label: "Storage used",
      value: dashboard ? formatBytes(dashboard.counts.storageUsedBytes) : undefined,
      sub: "of total used",
      icon: <DatabaseIcon size={18} />,
      tone: "accent" as const,
    },
  ];

  const tileTone = {
    primary: "bg-primary-tint text-primary",
    success: "bg-success-tint text-success",
    info: "bg-info-tint text-info",
    accent: "bg-accent-tint text-accent",
  };

  return (
    <AppShell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">
            {currentOrg?.name}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">Organization overview</p>
        </div>
        <span
          className={`hidden shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13px] font-medium text-ink sm:flex ${CARD_SHADOW}`}
        >
          {todayLabel()}
        </span>
      </div>

      {isSuperAdmin ? (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {tiles.map((tile) => (
              <div key={tile.label} className={`rounded-2xl border border-line bg-surface px-6 py-5 ${CARD_SHADOW}`}>
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${tileTone[tile.tone]}`}
                  >
                    {tile.icon}
                  </span>
                  <p className="text-[13px] font-medium text-subtle">{tile.label}</p>
                </div>
                <p className="mt-4 text-[32px] font-bold leading-none tracking-[-0.5px] text-ink">
                  {tile.value ?? "—"}
                </p>
                <p className="mt-2 text-[12px] text-subtle">{tile.sub}</p>
              </div>
            ))}
          </div>

          <div className={`mt-8 rounded-2xl border border-line bg-surface ${CARD_SHADOW}`}>
            <div className="flex items-center justify-between border-b border-line-muted px-6 py-5">
              <h2 className="text-[19px] font-semibold tracking-[-0.2px] text-ink">Departments</h2>
              {dashboard && dashboard.departments.length > 0 && (
                <Link
                  to="/departments/new"
                  className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted"
                >
                  <PlusIcon size={14} /> New department
                </Link>
              )}
            </div>
            {dashboard && dashboard.departments.length > 0 ? (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-surface-muted">
                    <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                      Department
                    </th>
                    <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                      Members
                    </th>
                    <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                      Docs
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.departments.map((d) => (
                    <tr key={d.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/60">
                      <td className="px-6 py-4">
                        <Link
                          to={`/departments/${d.id}`}
                          className="flex items-center gap-2.5 text-[15px] font-medium text-ink hover:text-primary"
                        >
                          <FolderIcon className="text-subtle" />
                          {d.name}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-[15px] text-muted">{d.memberCount}</td>
                      <td className="px-6 py-4 text-[15px] text-muted">{d.documentCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex flex-col items-center px-6 py-16 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-line text-subtle">
                  <FolderIcon size={22} />
                </span>
                <p className="mt-5 text-[15px] font-semibold text-ink">No departments yet</p>
                <p className="mt-1.5 max-w-sm text-[13.5px] text-subtle">
                  A department carries its own document types, fields, vocabulary and roles. Start
                  from a template and adjust.
                </p>
                <Link
                  to="/departments/new"
                  className="mt-6 flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-action transition-all hover:bg-primary-dark"
                >
                  <PlusIcon size={15} /> Create the first department
                </Link>
              </div>
            )}
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <div className={`rounded-2xl border border-line bg-surface p-6 ${CARD_SHADOW}`}>
              <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                <DatabaseIcon size={17} className="text-subtle" /> Storage
              </h3>
              {dashboard?.storage ? (
                <>
                  <div className="mt-4 flex items-center gap-2">
                    <DatabaseIcon size={16} className="text-subtle" />
                    <span className="text-[15px] font-medium text-ink">
                      {dashboard.storage.backendType.toUpperCase()}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${
                        dashboard.storage.status === "verified"
                          ? "bg-success-tint text-success"
                          : "bg-danger-tint text-danger"
                      }`}
                    >
                      {dashboard.storage.status === "verified" ? "Connected" : dashboard.storage.status}
                    </span>
                  </div>
                  <p className="mt-4 text-[13.5px] text-subtle">
                    {formatBytes(dashboard.counts.storageUsedBytes)} used of storage
                  </p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: dashboard.counts.storageUsedBytes === "0" ? "1.5%" : "100%" }}
                    />
                  </div>
                </>
              ) : (
                <p className="mt-4 text-[13.5px] text-subtle">Not configured yet.</p>
              )}
              <Link
                to="/storage-setup"
                className="mt-5 flex items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary-tint/60 px-4 py-3 text-[13.5px] font-semibold text-primary transition-colors hover:bg-primary-tint"
              >
                {dashboard?.storage ? "Manage storage" : "Configure storage"}
                <ChevronRightIcon size={15} />
              </Link>
            </div>

            <div className={`rounded-2xl border border-line bg-surface p-6 ${CARD_SHADOW}`}>
              <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                <BoltIcon size={16} className="text-subtle" /> Quick actions
              </h3>
              <div className="mt-4 space-y-2">
                <Link
                  to="/user-directory"
                  className="flex items-center justify-between rounded-lg border border-line-muted bg-surface-muted px-4 py-3 text-[13.5px] font-medium text-ink transition-colors hover:border-primary/40 hover:bg-surface"
                >
                  <span className="flex items-center gap-2.5">
                    <UsersIcon size={17} className="text-subtle" /> Manage users
                  </span>
                  <ChevronRightIcon size={15} className="text-subtle" />
                </Link>
                <Link
                  to="/organization-settings"
                  className="flex items-center justify-between rounded-lg border border-line-muted bg-surface-muted px-4 py-3 text-[13.5px] font-medium text-ink transition-colors hover:border-primary/40 hover:bg-surface"
                >
                  <span className="flex items-center gap-2.5">
                    <GearIcon size={17} className="text-subtle" /> Organization settings
                  </span>
                  <ChevronRightIcon size={15} className="text-subtle" />
                </Link>
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="mt-8 text-[13.5px] text-subtle">
          Department workspace, folders, and documents are not built yet — this is the
          authenticated landing spot until then.
        </p>
      )}

      <div
        className={`mt-6 flex items-center justify-between rounded-xl border border-line-muted bg-surface px-5 py-3.5 text-[13px] ${CARD_SHADOW}`}
      >
        <span className="flex items-center gap-2 font-medium text-muted">
          <DatabaseIcon size={14} className="text-subtle" /> Backend connection
        </span>
        {health ? (
          <span className="flex items-center gap-2 text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Connected
            <span className="text-line">|</span>
            <span className="font-mono text-subtle">{health.timestamp}</span>
          </span>
        ) : (
          <span className="text-subtle">checking...</span>
        )}
      </div>
    </AppShell>
  );
}
