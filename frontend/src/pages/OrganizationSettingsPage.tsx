import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { AppShell } from "../components/AppShell";
import { FieldError, FieldLabel, inputBase, inputClass, primaryButtonClass } from "../components/AuthCard";

interface OrganizationDetail {
  id: string;
  name: string;
  industry: string | null;
  subfolderDepthLimit: number;
  createdAt: string;
}

export function OrganizationSettingsPage() {
  const organizations = useAuthStore((s) => s.organizations);
  const currentOrganizationId = useAuthStore((s) => s.currentOrganizationId);
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);

  const { data, refetch } = useQuery({
    queryKey: ["organization"],
    queryFn: () => apiRequest<{ organization: OrganizationDetail }>("/organizations/current"),
    enabled: currentOrg?.isSuperAdmin ?? false,
  });

  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [subfolderDepthLimit, setSubfolderDepthLimit] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.organization) {
      setName(data.organization.name);
      setIndustry(data.organization.industry ?? "");
      setSubfolderDepthLimit(data.organization.subfolderDepthLimit);
    }
  }, [data]);

  if (!currentOrg?.isSuperAdmin) {
    return (
      <AppShell>
        <p className="text-[14.5px] text-muted">Only the Super Admin can edit organization settings.</p>
      </AppShell>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await apiRequest("/organizations/current", {
        method: "PATCH",
        body: JSON.stringify({ name, industry: industry || undefined, subfolderDepthLimit }),
      });
      setSaved(true);
      await refetch();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">
        Organization settings
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        These apply across every department unless a department overrides them.
      </p>

      <div className="mt-8 max-w-2xl rounded-2xl border border-line bg-surface p-8 shadow-card">
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <FieldLabel>Organization name</FieldLabel>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <FieldLabel>Industry (optional)</FieldLabel>
            <input className={inputClass} value={industry} onChange={(e) => setIndustry(e.target.value)} />
          </div>
          <div>
            <FieldLabel>Default subfolder depth limit</FieldLabel>
            <input
              type="number"
              min={1}
              max={20}
              className={`${inputBase} max-w-[160px]`}
              value={subfolderDepthLimit}
              onChange={(e) => setSubfolderDepthLimit(Number(e.target.value))}
              required
            />
          </div>

          <FieldError message={error ?? undefined} />
          {saved && !error && <p className="text-[13px] text-success">Settings saved.</p>}

          <button type="submit" className={`${primaryButtonClass} w-auto px-6`} disabled={submitting}>
            {submitting ? "Saving..." : "Save settings"}
          </button>
        </form>
      </div>
    </AppShell>
  );
}
