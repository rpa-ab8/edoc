import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore, type AuthUser, type OrganizationSummary } from "../store/authStore";
import { AuthCard, FieldError, FieldLabel, inputClass, primaryButtonClass } from "../components/AuthCard";

type SignupMode = "open" | "invite_code" | "disabled";

export function CreateOrganizationPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<SignupMode | null>(null);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiRequest<{ mode: SignupMode }>("/auth/signup-mode")
      .then((res) => setMode(res.mode))
      .catch(() => setMode("invite_code"));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await apiRequest<{
        organization: { id: string; name: string };
        accessToken: string;
      }>("/auth/organizations", {
        method: "POST",
        body: JSON.stringify({
          name,
          industry: industry || undefined,
          inviteCode: mode === "invite_code" ? inviteCode : undefined,
        }),
      });

      useAuthStore.getState().setAccessToken(result.accessToken);
      const me = await apiRequest<{ user: AuthUser; organizations: OrganizationSummary[] }>(
        "/auth/me",
      );
      useAuthStore.getState().setUser(me.user);
      useAuthStore.getState().setOrganizations(me.organizations);
      useAuthStore.getState().selectOrganization(result.organization.id);

      navigate(me.user.emailVerified ? "/onboarding" : "/verify-email-pending");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "disabled") {
    return (
      <AuthCard title="Create your organization" step={{ current: 3, total: 3 }}>
        <p className="text-[13.5px] text-danger">Organization creation is currently disabled.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your organization"
      subtitle="This becomes the workspace your team's documents live in."
      step={{ current: 3, total: 3 }}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <FieldLabel>Organization name</FieldLabel>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <FieldLabel>Industry (optional)</FieldLabel>
          <input className={inputClass} value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </div>
        {mode === "invite_code" && (
          <div>
            <FieldLabel>Invite code</FieldLabel>
            <input
              className={inputClass}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
            />
          </div>
        )}
        <FieldError message={error ?? undefined} />
        <button type="submit" className={primaryButtonClass} disabled={submitting || mode === null}>
          {submitting ? "Creating..." : "Create organization"}
        </button>
      </form>
    </AuthCard>
  );
}
