import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore, type AuthUser, type OrganizationSummary } from "../store/authStore";
import {
  AuthCard,
  Field,
  FormAlert,
  PasswordInput,
  Spinner,
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
    <AuthCard title="Sign in to Edoc" subtitle="Enter your work email and password to open your documents.">
      <form onSubmit={onSubmit} className="space-y-5">
        <FormAlert message={error} />
        <Field label="Email">
          {(id) => (
            <input
              id={id}
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          )}
        </Field>
        <Field
          label="Password"
          action={
            <Link to="/forgot-password" className={`text-[13.5px] ${linkClass}`}>
              Forgot password?
            </Link>
          }
        >
          {(id) => (
            <PasswordInput
              id={id}
              autoComplete="current-password"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <button
          type="submit"
          className={`${primaryButtonClass} flex items-center justify-center gap-2 py-3`}
          disabled={submitting}
        >
          {submitting && <Spinner />}
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-8 border-t border-line pt-6 text-[14px] text-muted">
        New to Edoc?{" "}
        <Link to="/register" className={linkClass}>
          Create an account
        </Link>
      </p>
    </AuthCard>
  );
}
