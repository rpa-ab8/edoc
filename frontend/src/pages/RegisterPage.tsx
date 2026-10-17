import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore, type AuthUser } from "../store/authStore";
import {
  AuthCard,
  FieldError,
  FieldLabel,
  inputClass,
  linkClass,
  primaryButtonClass,
} from "../components/AuthCard";

export function RegisterPage() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await apiRequest<{ user: AuthUser; accessToken: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ fullName, email, password }),
      });
      useAuthStore.getState().setSession({
        accessToken: result.accessToken,
        user: result.user,
        organizations: [],
      });
      navigate("/create-organization");
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
    <AuthCard
      title="Create your account"
      subtitle="Set up access to your organization's document workspace."
      step={{ current: 1, total: 3 }}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <FieldLabel>Full name</FieldLabel>
          <input
            className={inputClass}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </div>
        <div>
          <FieldLabel>Work email</FieldLabel>
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
            minLength={8}
            required
          />
        </div>
        <FieldError message={error ?? undefined} />
        <button type="submit" className={primaryButtonClass} disabled={submitting}>
          {submitting ? "Creating account..." : "Create account"}
        </button>
      </form>
      <p className="mt-5 text-center text-[13.5px] text-muted">
        Already have an account?{" "}
        <Link to="/login" className={linkClass}>
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
