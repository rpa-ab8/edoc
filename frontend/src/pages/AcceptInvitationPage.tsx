import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AuthCard, FieldError, FieldLabel, SuccessIcon, inputClass, linkClass, primaryButtonClass } from "../components/AuthCard";
import { apiRequest, ApiRequestError } from "../lib/api";
import { acceptInvitation, fetchInvitationPreview } from "../lib/invitations";
import { useAuthStore, type AuthUser, type OrganizationSummary } from "../store/authStore";

export function AcceptInvitationPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const signedInUser = useAuthStore((s) => s.user);

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const { data: invitation, error: previewError } = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => fetchInvitationPreview(token),
    retry: false,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await acceptInvitation(token, invitation?.hasAccount ? {} : { fullName, password });

      if (result.accessToken) {
        // A brand-new account is signed in straight away — the invitation already proved the
        // address, so bouncing them to a login screen would ask for the same thing twice.
        useAuthStore.getState().setAccessToken(result.accessToken);
        const me = await apiRequest<{ user: AuthUser; organizations: OrganizationSummary[] }>("/auth/me");
        useAuthStore.getState().setSession({
          accessToken: result.accessToken,
          user: me.user,
          organizations: me.organizations,
        });
      }
      useAuthStore.getState().selectOrganization(result.organizationId);
      setAccepted(true);
      setTimeout(() => navigate("/"), 1200);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  if (previewError) {
    const message =
      previewError instanceof ApiRequestError ? previewError.message : "This invitation link isn't valid.";
    return (
      <AuthCard title="Invitation unavailable" subtitle={message}>
        <Link to="/login" className={linkClass}>
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  if (!invitation) {
    return <AuthCard title="Checking your invitation…" subtitle="One moment." children={null} />;
  }

  if (accepted) {
    return (
      <AuthCard title="You're in" subtitle={`Welcome to ${invitation.organizationName}.`}>
        <SuccessIcon />
        <p className="text-center text-[14px] text-muted">Taking you to your workspace…</p>
      </AuthCard>
    );
  }

  const summary = (
    <div className="mb-6 rounded-xl border border-line bg-surface-muted px-4 py-3.5">
      <dl className="space-y-1.5 text-[14px]">
        <div className="flex justify-between gap-4">
          <dt className="text-subtle">Organization</dt>
          <dd className="font-medium text-ink">{invitation.organizationName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-subtle">Department</dt>
          <dd className="font-medium text-ink">{invitation.departmentName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-subtle">Role</dt>
          <dd className="font-medium text-ink">{invitation.roleName}</dd>
        </div>
      </dl>
    </div>
  );

  // Someone who already has an account has to be signed in as that address: holding the link
  // proves control of the inbox, not of the account that owns it.
  if (invitation.hasAccount && signedInUser?.email !== invitation.email) {
    return (
      <AuthCard
        title="Sign in to accept"
        subtitle={`This invitation is for ${invitation.email}, which already has an account.`}
      >
        {summary}
        <Link
          to={`/login?next=${encodeURIComponent(`/invitations/${token}`)}`}
          className={`${primaryButtonClass} block`}
        >
          Sign in as {invitation.email}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={`Join ${invitation.organizationName}`}
      subtitle={
        invitation.hasAccount
          ? `Accept to add ${invitation.departmentName} to your workspace.`
          : `You've been invited as ${invitation.email}. Set a password to finish.`
      }
    >
      {summary}

      {/* Accepting signs you in as the invited address. Saying so beats silently swapping the
          session out from under someone who is already signed in as somebody else. */}
      {signedInUser && signedInUser.email !== invitation.email && (
        <p className="mb-4 rounded-xl bg-warning-tint px-4 py-3 text-[13.5px] leading-relaxed text-ink">
          You're signed in as <span className="font-medium">{signedInUser.email}</span>. Accepting
          this invitation will sign you in as {invitation.email} instead.
        </p>
      )}

      <form onSubmit={submit} className="space-y-4">
        {!invitation.hasAccount && (
          <>
            <div>
              <FieldLabel>Your name</FieldLabel>
              <input
                className={inputClass}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
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
                autoComplete="new-password"
                minLength={8}
                required
              />
              <p className="mt-2 text-[13px] text-subtle">At least 8 characters.</p>
            </div>
          </>
        )}

        <FieldError message={error ?? undefined} />

        <button type="submit" className={primaryButtonClass} disabled={submitting}>
          {submitting ? "Accepting…" : "Accept invitation"}
        </button>
      </form>
    </AuthCard>
  );
}
