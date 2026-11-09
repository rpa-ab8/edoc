import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { inputBase, primaryButtonBase } from "../components/AuthCard";
import { DateRangePicker } from "../components/DateRangePicker";
import { Select } from "../components/Select";
import { ChevronLeftIcon, DownloadIcon, LockIcon } from "../components/icons";
import { ApiRequestError } from "../lib/api";
import { fetchOrgUsers } from "../lib/sharing";
import {
  ACTION_LABELS,
  actionTone,
  exportAuditCsv,
  fetchAudit,
  type AuditAction,
  type AuditFilters,
} from "../lib/audit";

const TONE_CLASS: Record<ReturnType<typeof actionTone>, string> = {
  danger: "bg-danger-tint text-danger",
  warning: "bg-warning-tint text-warning",
  info: "bg-info-tint text-info",
  muted: "bg-surface-muted text-muted",
};

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// The "User" filter's choice for events no person caused (actorType = system).
const SYSTEM = "__system__";

/** The department's audit log (AUD-2/4/5): four combinable filters, colour-weighted actions, and a
 *  CSV export shown only to holders of the separate Export-audit permission. */
export function AuditPage() {
  const { departmentId = "" } = useParams();
  const navigate = useNavigate();

  const [actorUserId, setActorUserId] = useState("");
  const [action, setAction] = useState<AuditAction | "">("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const filters: AuditFilters = useMemo(
    () => ({
      actorUserId: actorUserId && actorUserId !== SYSTEM ? actorUserId : undefined,
      actorType: actorUserId === SYSTEM ? ("system" as const) : undefined,
      action: action || undefined,
      documentQuery: documentQuery.trim() || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      // Include the whole "to" day by pushing to its end.
      to: to ? new Date(new Date(to).setHours(23, 59, 59, 999)).toISOString() : undefined,
    }),
    [actorUserId, action, documentQuery, from, to],
  );

  const { data, isFetching, error } = useQuery({
    queryKey: ["audit", departmentId, filters],
    queryFn: () => fetchAudit(departmentId, filters),
    retry: false,
  });
  const { data: users = [] } = useQuery({ queryKey: ["org-users"], queryFn: fetchOrgUsers, retry: false });

  async function doExport() {
    setExporting(true);
    setExportError(null);
    try {
      await exportAuditCsv(departmentId, filters);
    } catch (err) {
      setExportError(err instanceof ApiRequestError ? err.message : "Couldn't export.");
    } finally {
      setExporting(false);
    }
  }

  const forbidden = error instanceof ApiRequestError && error.status === 403;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface/95 px-6 py-3.5 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate(`/w/${departmentId}`)}
          className="flex items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-primary"
        >
          <ChevronLeftIcon size={16} /> Workspace
        </button>
        <h1 className="ml-1 text-[16px] font-bold tracking-[-0.3px] text-ink">Audit log</h1>
        {data?.includesConfidential && (
          <span className="flex items-center gap-1.5 rounded-md bg-warning-tint px-2 py-0.5 text-[11.5px] font-medium text-warning">
            <LockIcon size={12} /> Includes confidential events
          </span>
        )}
        {data?.canExport && (
          <button
            type="button"
            disabled={exporting}
            onClick={() => void doExport()}
            className={`${primaryButtonBase} ml-auto flex items-center gap-2 px-4 py-2`}
          >
            <DownloadIcon size={15} /> {exporting ? "Exporting…" : "Export CSV"}
          </button>
        )}
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
        {/* Filters */}
        <div className="mb-5 grid grid-cols-1 gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink">User</label>
            <Select
              value={actorUserId}
              onChange={setActorUserId}
              placeholder="Anyone"
              ariaLabel="User"
              options={[
                { value: "", label: "Anyone" },
                { value: SYSTEM, label: "System", hint: "Auto-delete and Trash purge" },
                ...users.map((u) => ({ value: u.id, label: u.fullName, hint: u.email })),
              ]}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink">Action</label>
            <Select
              value={action}
              onChange={(v) => setAction(v as AuditAction | "")}
              placeholder="Any action"
              ariaLabel="Action"
              options={[
                { value: "", label: "Any action" },
                ...(Object.keys(ACTION_LABELS) as AuditAction[]).map((a) => ({ value: a, label: ACTION_LABELS[a] })),
              ]}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink">Document</label>
            <input
              className={`${inputBase} w-full`}
              value={documentQuery}
              placeholder="ID or text"
              onChange={(e) => setDocumentQuery(e.target.value)}
            />
          </div>
          <div className="lg:col-span-2">
            <label className="mb-1.5 block text-[12px] font-medium text-ink">Date</label>
            <DateRangePicker
              from={from}
              to={to}
              onChange={(f, t) => {
                setFrom(f);
                setTo(t);
              }}
              presets
              label="Event date"
              className="w-full"
            />
          </div>
        </div>

        {exportError && <p className="mb-3 text-[13px] text-danger">{exportError}</p>}

        {forbidden ? (
          <p className="text-[14px] text-subtle">You don't have permission to view this department's audit log.</p>
        ) : error ? (
          <p className="text-[14px] text-subtle">Couldn't load the audit log.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-line bg-surface-muted px-5 py-3">
              <span className="text-[13px] text-subtle">
                {isFetching ? "Loading…" : `${data?.events.length ?? 0} event${(data?.events.length ?? 0) === 1 ? "" : "s"}`}
              </span>
            </div>
            {(data?.events.length ?? 0) === 0 && !isFetching ? (
              <p className="px-5 py-12 text-center text-[14px] text-subtle">No events match these filters.</p>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                    <th className="px-5 py-3">When</th>
                    <th className="px-5 py-3">Who</th>
                    <th className="px-5 py-3">Action</th>
                    <th className="px-5 py-3">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.events.map((e) => (
                    <tr key={e.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/50">
                      <td className="whitespace-nowrap px-5 py-3 text-[13px] text-muted">{whenLabel(e.occurredAt)}</td>
                      <td className="px-5 py-3 text-[13.5px] font-medium text-ink">
                        {e.actorType === "system" ? (
                          <span className="inline-flex items-center rounded-md bg-surface-muted px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                            System
                          </span>
                        ) : (
                          e.actorName
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${TONE_CLASS[actionTone(e.action)]}`}>
                          {ACTION_LABELS[e.action]}
                        </span>
                        {e.isConfidential && (
                          <LockIcon size={12} className="ml-1.5 inline text-warning" aria-label="Confidential" />
                        )}
                      </td>
                      <td className="px-5 py-3 text-[13.5px] text-muted">{e.targetDescription ?? e.documentRef ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
