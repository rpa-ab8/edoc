import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "../components/AppShell";
import { StatusPill } from "../components/AuthCard";
import { FolderIcon, PlusIcon } from "../components/icons";
import { fetchDepartments } from "../lib/departments";
import { useAuthStore } from "../store/authStore";

const CARD_SHADOW = "shadow-card";

export function DepartmentsPage() {
  const { organizations, currentOrganizationId } = useAuthStore();
  const isSuperAdmin = organizations.find((o) => o.id === currentOrganizationId)?.isSuperAdmin ?? false;

  const { data: departments } = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">Departments</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Each department is a self-contained workspace with its own schema, roles and folders.
          </p>
        </div>
        {isSuperAdmin && (
          <Link
            to="/departments/new"
            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-action transition-colors hover:bg-primary-dark"
          >
            <PlusIcon size={15} /> New department
          </Link>
        )}
      </div>

      <div className={`mt-8 overflow-hidden rounded-2xl border border-line bg-surface ${CARD_SHADOW}`}>
        {departments && departments.length > 0 ? (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-surface-muted">
                <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                  Department
                </th>
                <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Prefix</th>
                <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Types</th>
                <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Members</th>
                <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Docs</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {departments.map((d) => (
                <tr key={d.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/60">
                  <td className="px-6 py-4">
                    <Link to={`/departments/${d.id}`} className="flex items-center gap-2.5">
                      <FolderIcon className="text-subtle" />
                      <span className="text-[15px] font-medium text-ink">{d.name}</span>
                      {d.status === "archived" && <StatusPill tone="warning">Archived</StatusPill>}
                    </Link>
                    <p className="mt-0.5 pl-[26px] text-[13px] text-subtle">
                      {d.subjectTerm ?? "Record"} · {d.identifierTerm ?? "Reference"}
                    </p>
                  </td>
                  <td className="px-6 py-4"><span className="plate px-2.5 py-1 text-[12px]">{d.idPrefix}</span></td>
                  <td className="px-6 py-4 text-[15px] text-muted">{d.documentTypeCount}</td>
                  <td className="px-6 py-4 text-[15px] text-muted">{d.memberCount}</td>
                  <td className="px-6 py-4 text-[15px] text-muted">{d.documentCount}</td>
                  <td className="px-6 py-4">
                    <span className="flex items-center justify-end gap-4">
                      <Link
                        to={`/w/${d.id}`}
                        className="text-[13.5px] font-medium text-primary hover:underline"
                      >
                        Open files
                      </Link>
                      <Link
                        to={`/departments/${d.id}`}
                        className="text-[13.5px] font-medium text-primary hover:underline"
                      >
                        Settings
                      </Link>
                    </span>
                  </td>
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
              A department carries its own document types, fields, vocabulary and roles. Start from
              a template and adjust.
            </p>
            {isSuperAdmin && (
              <Link
                to="/departments/new"
                className="mt-6 flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-action transition-colors hover:bg-primary-dark"
              >
                <PlusIcon size={15} /> Create the first department
              </Link>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
