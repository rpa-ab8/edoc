import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiRequestError } from "../lib/api";
import {
  FieldError,
  FieldLabel,
  StatusPill,
  inputClass,
  primaryButtonBase,
  primaryButtonClass,
  secondaryButtonBase,
} from "./AuthCard";
import { CheckCircleIcon, CloudIcon, DatabaseIcon, ShieldIcon } from "./icons";

type BackendType = "nas" | "r2";

interface StorageStatus {
  backendType: BackendType;
  status: "pending" | "verified" | "error";
  lastTestedAt: string | null;
  quotaBytes: string | null;
  usedBytes: string;
}

const BACKEND_OPTIONS: {
  type: BackendType;
  title: string;
  description: string;
  icon: ReactElement;
}[] = [
  {
    type: "r2",
    title: "Cloudflare R2",
    description: "Cloud object storage. No egress fees, works from anywhere with internet access.",
    icon: <CloudIcon size={26} />,
  },
  {
    type: "nas",
    title: "NAS",
    description: "Your own on-premise network share. Zero marginal storage cost on hardware you own.",
    icon: <DatabaseIcon size={26} />,
  },
];

function formatBytes(raw: string): string {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${exp === 0 ? bytes : (bytes / 1024 ** exp).toFixed(1)} ${units[exp]}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Two states, deliberately: when storage is connected this screen *reports* — it does not open on
 * an empty form inviting you to connect something you already have. Replacing a working backend is
 * a rare, consequential action, so it sits behind a warning rather than being the default view.
 */
export function StorageConnectionForm({ onVerified }: { onVerified?: () => void }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["storage-config"],
    queryFn: () => apiRequest<{ storage: StorageStatus | null }>("/storage/config"),
  });

  // "idle" = report what's connected · "warned" = confirming the consequences · "editing" = the form
  const [changeStage, setChangeStage] = useState<"idle" | "warned" | "editing">("idle");
  const [backendType, setBackendType] = useState<BackendType>("r2");
  const [mountPath, setMountPath] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justVerified, setJustVerified] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const connected = data?.storage ?? null;
  const showForm = !connected || changeStage === "editing";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setJustVerified(false);
    setSubmitting(true);
    try {
      const body =
        backendType === "nas"
          ? { backendType: "nas" as const, mountPath }
          : { backendType: "r2" as const, endpoint, bucket, accessKeyId, secretAccessKey };
      await apiRequest("/storage/config", { method: "POST", body: JSON.stringify(body) });
      setJustVerified(true);
      setChangeStage("idle");
      await refetch();
      onVerified?.();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      await apiRequest("/storage/config/test", { method: "POST" });
      setTestResult("Connection tested — write, read back and delete all passed.");
      await refetch();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
      await refetch();
    } finally {
      setTesting(false);
    }
  }

  if (isLoading) {
    return <p className="text-[14.5px] text-muted">Checking storage…</p>;
  }

  return (
    <>
      {connected && changeStage !== "editing" && (
        <div>
          <div className="flex flex-wrap items-start gap-4 rounded-2xl border border-line bg-surface-muted p-6">
            <span
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full ${
                connected.status === "verified"
                  ? "bg-success-tint text-success"
                  : "bg-danger-tint text-danger"
              }`}
            >
              {connected.backendType === "r2" ? <CloudIcon size={26} /> : <DatabaseIcon size={26} />}
            </span>
            <div className="min-w-[200px] flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <p className="text-[19px] font-semibold tracking-[-0.2px] text-ink">
                  {connected.backendType === "r2" ? "Cloudflare R2" : "NAS"}
                </p>
                <StatusPill tone={connected.status === "verified" ? "success" : "danger"}>
                  {connected.status === "verified" ? "Connected" : connected.status}
                </StatusPill>
              </div>
              <p className="mt-1 text-[14px] text-muted">
                {connected.status === "verified"
                  ? "Documents are being stored here."
                  : "This backend failed its last check — documents cannot be stored until it passes."}
              </p>

              <dl className="mt-5 grid gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-[12px] text-subtle">Last tested</dt>
                  <dd className="mt-0.5 text-[13.5px] font-medium text-ink">
                    {formatWhen(connected.lastTestedAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[12px] text-subtle">Storage used</dt>
                  <dd className="mt-0.5 text-[13.5px] font-medium text-ink">
                    {formatBytes(connected.usedBytes)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[12px] text-subtle">Quota</dt>
                  <dd className="mt-0.5 text-[13.5px] font-medium text-ink">
                    {connected.quotaBytes ? formatBytes(connected.quotaBytes) : "Not set"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {testResult && <p className="mt-4 text-[13px] text-success">{testResult}</p>}
          <FieldError message={error ?? undefined} />

          {changeStage === "idle" ? (
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" onClick={retest} disabled={testing} className={`${primaryButtonBase} px-6`}>
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setChangeStage("warned");
                  setTestResult(null);
                  setError(null);
                }}
                className={`${secondaryButtonBase} px-6`}
              >
                Change storage backend
              </button>
            </div>
          ) : (
            // The warning is specific about what is lost, because "are you sure?" tells nobody
            // anything. Files already written are not migrated by this app — that is the whole risk.
            <div className="mt-5 rounded-2xl border border-warning/40 bg-warning-tint p-6">
              <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                <ShieldIcon size={17} className="text-warning" />
                Before you change storage
              </h3>
              <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-muted">
                <li>
                  <span className="font-medium text-ink">Existing files are not moved.</span> Anything
                  already stored in {connected.backendType === "r2" ? "Cloudflare R2" : "the NAS share"}{" "}
                  stays there, and this organization will no longer read from it.
                </li>
                <li>
                  <span className="font-medium text-ink">Document records stay intact.</span> IDs,
                  metadata and version history are in the database, not the storage backend — but
                  their files will not be retrievable through the new connection.
                </li>
                <li>
                  <span className="font-medium text-ink">Nothing changes until the new connection passes.</span>{" "}
                  If the test fails, your current storage is left exactly as it is.
                </li>
              </ul>
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setChangeStage("editing")}
                  className={`${primaryButtonBase} px-6`}
                >
                  I understand — change it
                </button>
                <button
                  type="button"
                  onClick={() => setChangeStage("idle")}
                  className={`${secondaryButtonBase} px-6`}
                >
                  Keep current storage
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <>
          {connected && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted px-4 py-3">
              <span className="text-[14px] text-muted">
                Replacing{" "}
                <span className="font-medium text-ink">
                  {connected.backendType === "r2" ? "Cloudflare R2" : "NAS"}
                </span>
                . Your current storage stays active until this test passes.
              </span>
              <button
                type="button"
                onClick={() => {
                  setChangeStage("idle");
                  setError(null);
                }}
                className="text-[13px] font-medium text-primary hover:underline"
              >
                Cancel
              </button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {BACKEND_OPTIONS.map((option) => {
              const selected = backendType === option.type;
              return (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => setBackendType(option.type)}
                  aria-pressed={selected}
                  className={`relative rounded-2xl border p-7 text-left transition-all ${
                    selected
                      ? "border-primary bg-primary-tint shadow-action"
                      : "border-line-muted bg-surface-muted hover:border-primary/40 hover:bg-surface"
                  }`}
                >
                  {selected && (
                    <span className="absolute right-5 top-5 text-primary">
                      <CheckCircleIcon size={20} />
                    </span>
                  )}
                  <span
                    className={`flex h-14 w-14 items-center justify-center rounded-full ${
                      selected ? "bg-primary text-white" : "bg-surface text-muted ring-1 ring-line-muted"
                    }`}
                  >
                    {option.icon}
                  </span>
                  <p className="mt-5 text-[19px] font-semibold tracking-[-0.2px] text-ink">{option.title}</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{option.description}</p>
                </button>
              );
            })}
          </div>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {backendType === "nas" ? (
              <div>
                <FieldLabel>Mount path</FieldLabel>
                <input
                  className={inputClass}
                  value={mountPath}
                  onChange={(e) => setMountPath(e.target.value)}
                  placeholder="/mnt/dms-storage or \\server\share"
                  required
                />
              </div>
            ) : (
              <>
                <div>
                  <FieldLabel>Endpoint</FieldLabel>
                  <input
                    className={inputClass}
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://<account-id>.r2.cloudflarestorage.com"
                    required
                  />
                </div>
                <div>
                  <FieldLabel>Bucket</FieldLabel>
                  <input className={inputClass} value={bucket} onChange={(e) => setBucket(e.target.value)} required />
                </div>
                <div>
                  <FieldLabel>Access key ID</FieldLabel>
                  <input
                    className={inputClass}
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <FieldLabel>Secret access key</FieldLabel>
                  <input
                    type="password"
                    className={inputClass}
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            <FieldError message={error ?? undefined} />
            {justVerified && !error && <p className="text-[13px] text-success">Connection verified and saved.</p>}

            <button type="submit" className={primaryButtonClass} disabled={submitting}>
              {submitting ? "Testing connection..." : "Test & save connection"}
            </button>
          </form>
        </>
      )}
    </>
  );
}
