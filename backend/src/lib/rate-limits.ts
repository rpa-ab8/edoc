/**
 * Per-route rate limits for the unauthenticated surface (login, sign-up, password reset, invitation
 * and external-link endpoints). Applied opt-in via `config: { rateLimit: RATE_LIMITS.x }` — there is
 * deliberately no global limit, because a whole office typically shares one public IP and a global
 * per-IP cap would throttle 250 signed-in users as if they were one client.
 *
 * Keyed by client IP, so production must run with TRUST_PROXY=true behind Caddy; otherwise every
 * request carries the proxy's IP and these limits apply to everyone at once.
 */
export const RATE_LIMITS = {
  /** Sends mail or creates/changes credentials: register, forgot/reset password, resend, accept invite. */
  sensitive: { max: 10, timeWindow: "1 minute" },
  /** Credential checks: login, email verification. Per-email lockout (AUTH-7) still applies on top. */
  login: { max: 30, timeWindow: "1 minute" },
  /** Token-addressed public reads: invitation preview, external link open and file. */
  publicRead: { max: 120, timeWindow: "1 minute" },
} as const;
