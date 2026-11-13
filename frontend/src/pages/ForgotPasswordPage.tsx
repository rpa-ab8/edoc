import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { AuthCard, FieldLabel, SuccessIcon, inputClass, linkClass, primaryButtonClass } from "../components/AuthCard";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <AuthCard
      title={sent ? "Check your inbox" : "Reset your password"}
      subtitle={sent ? undefined : "Enter your email and we'll send you a reset link."}
    >
      {sent ? (
        <>
          <SuccessIcon />
          <p className="text-center text-[13.5px] text-muted">
            If an account exists for <span className="font-medium text-ink">{email}</span>, a
            reset link is on its way.
          </p>
        </>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <FieldLabel>Email</FieldLabel>
            <input
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <button type="submit" className={primaryButtonClass} disabled={submitting}>
            {submitting ? "Sending..." : "Send reset link"}
          </button>
        </form>
      )}
      <p className="mt-8 border-t border-line pt-6 text-[14px]">
        <Link to="/login" className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
