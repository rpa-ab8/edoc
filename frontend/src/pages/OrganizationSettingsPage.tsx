import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { AppShell } from "../components/AppShell";
import { FieldError, FieldLabel, inputBase, inputClass, primaryButtonClass } from "../components/AuthCard";
import { Select } from "../components/Select";

interface OrganizationDetail {
  id: string;
  name: string;
  industry: string | null;
  subfolderDepthLimit: number;
  timeZone: string;
  createdAt: string;
}

// The zones an organization is most likely to work in. A saved zone outside this list is still
// shown (it is added to the options), so nothing set elsewhere is silently replaced.
const TIME_ZONES: { zone: string; place: string }[] = [
  { zone: "Asia/Kolkata", place: "India" },
  { zone: "Asia/Dubai", place: "UAE, Oman" },
  { zone: "Asia/Riyadh", place: "Saudi Arabia, Kuwait, Qatar" },
  { zone: "Asia/Karachi", place: "Pakistan" },
  { zone: "Asia/Dhaka", place: "Bangladesh" },
  { zone: "Asia/Colombo", place: "Sri Lanka" },
  { zone: "Asia/Kathmandu", place: "Nepal" },
  { zone: "Asia/Singapore", place: "Singapore, Malaysia" },
  { zone: "Asia/Tokyo", place: "Japan" },
  { zone: "Australia/Sydney", place: "Australia (east)" },
  { zone: "Europe/London", place: "United Kingdom" },
  { zone: "Europe/Berlin", place: "Central Europe" },
  { zone: "Africa/Nairobi", place: "East Africa" },
  { zone: "America/New_York", place: "US Eastern" },
  { zone: "America/Chicago", place: "US Central" },
  { zone: "America/Los_Angeles", place: "US Pacific" },
  { zone: "UTC", place: "Coordinated Universal Time" },
];

function utcOffset(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return part === "GMT" ? "UTC+00:00" : (part ?? "").replace("GMT", "UTC");
  } catch {
    return "";
  }
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
  const [timeZone, setTimeZone] = useState("Asia/Kolkata");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.organization) {
      setName(data.organization.name);
      setIndustry(data.organization.industry ?? "");
      setSubfolderDepthLimit(data.organization.subfolderDepthLimit);
      setTimeZone(data.organization.timeZone);
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
        body: JSON.stringify({ name, industry: industry || undefined, subfolderDepthLimit, timeZone }),
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

          <div>
            <FieldLabel>Time zone</FieldLabel>
            <Select
              value={timeZone}
              onChange={setTimeZone}
              ariaLabel="Time zone"
              className="w-full max-w-md"
              options={[
                ...(TIME_ZONES.some((t) => t.zone === timeZone) ? [] : [{ zone: timeZone, place: "Current setting" }]),
                ...TIME_ZONES,
              ].map((t) => ({ value: t.zone, label: `${t.place} — ${utcOffset(t.zone)}`, hint: t.zone }))}
            />
            <p className="mt-2 text-[13px] leading-relaxed text-subtle">
              Calendar dates are read in this zone: the Upload Date filter, and the day a document reaches its
              auto-delete period.
            </p>
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
