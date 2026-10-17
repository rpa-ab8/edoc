import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, ApiRequestError, refreshAccessToken } from "../lib/api";
import { useAuthStore, type AuthUser, type OrganizationSummary } from "../store/authStore";
import { AuthCard, primaryButtonClass, secondaryButtonClass } from "../components/AuthCard";

export function VerifyEmailPendingPage() {
  const navigate = useNavigate();
  const email = useAuthStore((s) => s.user?.email);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function resend() {
    setStatus(null);
    try {
      await apiRequest("/auth/resend-verification", { method: "POST" });
      setStatus("Verification email sent again — check your inbox.");
    } catch (err) {
      setStatus(err instanceof ApiRequestError ? err.message : "Could not resend right now.");
    }
  }

  async function checkVerified() {
    setChecking(true);
    setStatus(null);
    try {
      const me = await apiRequest<{ user: AuthUser; organizations: OrganizationSummary[] }>(
        "/auth/me",
      );
      if (!me.user.emailVerified) {
        setStatus("Still not verified — click the link in the email first.");
        return;
      }
      const accessToken = await refreshAccessToken();
      if (accessToken) useAuthStore.getState().setAccessToken(accessToken);
      useAuthStore.getState().setUser(me.user);
      useAuthStore.getState().setOrganizations(me.organizations);

      if (me.organizations.length === 0) navigate("/create-organization");
      else if (me.organizations.length === 1) {
        const org = me.organizations[0]!;
        useAuthStore.getState().selectOrganization(org.id);
        // Verification only ever consumes once, so this is the one moment a Super Admin who
        // created their org while unverified first gets guided through onboarding.
        navigate(org.isSuperAdmin ? "/onboarding" : "/");
      } else navigate("/select-organization");
    } catch (err) {
      setStatus(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <AuthCard title="Verify your email" step={{ current: 2, total: 3 }}>
      <p className="text-[13.5px] leading-relaxed text-muted">
        We sent a verification link to <span className="font-medium text-ink">{email}</span>.
        Click it, then come back here.
      </p>
      {status && <p className="mt-3 text-[13px] text-muted">{status}</p>}
      <div className="mt-6 space-y-2.5">
        <button onClick={checkVerified} className={primaryButtonClass} disabled={checking}>
          {checking ? "Checking..." : "I've verified — continue"}
        </button>
        <button onClick={resend} className={secondaryButtonClass}>
          Resend verification email
        </button>
      </div>
    </AuthCard>
  );
}
