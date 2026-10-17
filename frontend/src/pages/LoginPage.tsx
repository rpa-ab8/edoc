import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore, type AuthUser, type OrganizationSummary } from "../store/authStore";
import {
  AuthCard,
  FieldError,
  FieldLabel,
  inputClass,
  linkClass,
  primaryButtonClass,
} from "../components/AuthCard";

interface LoginResponse {
  user: AuthUser;
  organizations: OrganizationSummary[];
  autoSelectedOrganizationId?: string;
  accessToken: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  // Set when someone was sent here to finish something else — accepting an invitation, today.
  // They go back to that, not to the dashboard.
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      useAuthStore.getState().setSession({
        accessToken: result.accessToken,
        user: result.user,
        organizations: result.organizations,
        currentOrganizationId: result.autoSelectedOrganizationId ?? null,
      });
      if (result.autoSelectedOrganizationId) {
        useAuthStore.getState().selectOrganization(result.autoSelectedOrganizationId);
      }

      if (!result.user.emailVerified) {
        navigate("/verify-email-pending");
      } else if (next?.startsWith("/")) {
        // Only relative paths, so a crafted ?next= can never bounce someone off-site.
        navigate(next);
      } else if (result.autoSelectedOrganizationId) {
        navigate("/");
      } else if (result.organizations.length === 0) {
        navigate("/create-organization");
      } else {
        navigate("/select-organization");
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Welcome back to your document workspace.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <FieldLabel>Email</FieldLabel>
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <FieldLabel>Password</FieldLabel>
          <input
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <FieldError message={error ?? undefined} />
        <button type="submit" className={primaryButtonClass} disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <div className="mt-5 flex justify-between text-[13.5px]">
        <Link to="/register" className={linkClass}>
          Create account
        </Link>
        <Link to="/forgot-password" className={linkClass}>
          Forgot password?
        </Link>
      </div>
    </AuthCard>
  );
}
