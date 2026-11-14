# Update Log

## 2026-07-21 — Project scaffolding (infrastructure only)

Scaffolded the repo per `docs/DMS_Technology_Stack.md`, no domain/feature logic.

**Structure:** npm workspaces monorepo (`backend/`, `frontend/`), confirmed with user over
generating a separate-packages layout.

**Backend** (`backend/`): Fastify + TypeScript, ESLint (flat config) + Prettier, `/health`
endpoint, Zod-validated env config (`src/config/env.ts`). Prisma (`@prisma/client`, `prisma` CLI)
wired into `package.json` scripts, but **`backend/prisma/schema.prisma` does not exist yet** —
user chose to add it themselves rather than have it generated from the Data Model doc. Migration/
`prisma generate`/`prisma studio` steps are blocked until it's placed; see `backend/prisma/README.md`.

**Frontend** (`frontend/`): React 19 + TypeScript + Vite + Tailwind. Single placeholder page
(`src/App.tsx`) calls the backend's `/health` via TanStack Query and displays status/timestamp.
Zustand installed but unused until real UI state exists.

**Docker Compose** (`docker-compose.yml`): Postgres 16 + Redis 7 only (backend/frontend run on
host via `npm run dev:*`, not containerized, for faster local iteration). Single shared root
`.env` (via `.env.example`) is read by docker-compose, the backend (`dotenv-cli` pointing at
`../.env`), and the frontend (Vite `envDir` pointed at repo root) — avoids duplicating env vars
across three files.

**Verified locally:**
- `npm install` — clean, 0 vulnerabilities
- Backend type-checks and lints clean; `npm run dev` boots, `/health` returns 200 with status/timestamp
- Frontend lints clean; `npm run dev` boots and serves the placeholder page, which fetches the
  live backend `/health` response
- Noted: something *other* than this project was already listening on port 5173 on this machine;
  Vite auto-fell-back to 5174 during testing. Not investigated at the time.
  **Correction (see 2026-07-21 auth entry below):** this was actually a stray Vite dev server
  from an earlier session of *this* project that never got shut down, not an unrelated process.

## 2026-07-21 — Docker + Prisma migration confirmed

User started Docker Desktop and added `schema.prisma`, but two local environment issues turned up:

1. **Port 5432 conflict:** a local (non-Docker) Postgres instance was already listening on the
   host's 5432. `docker-compose.yml` mapped the Postgres container to `5432:5432`, which would
   fail to bind. Fixed by moving the Docker Postgres to host port **5433** — changed
   `POSTGRES_PORT` in `.env` and `.env.example`, and updated `DATABASE_URL` to
   `postgresql://dms:dms@localhost:5433/dms`. `REDIS_PORT` (6379) had no conflict, left as-is.
2. **Schema in the wrong path:** the user placed the file at `backend/schema.prisma`, but our
   scripts/Prisma CLI expect `backend/prisma/schema.prisma` (standard Prisma location, documented
   in `backend/prisma/README.md`). Moved it into place.

After both fixes: `npm run docker:up` pulled images and started both containers healthy;
`prisma migrate dev --name init` applied cleanly; `\dt` in psql confirms all 24 data-model tables
present (organization, user, membership, department, role, folder, folder_permission, document,
document_ref_sequence, version, document_type, field_def, field_value, share,
confidential_member, audit_event, storage_config, refresh_token, password_reset_token,
email_verification_token, invitation, signup_setting, signup_invite_code, login_attempt) plus
Prisma's own `_prisma_migrations`.

**All four original checklist items now confirmed:** `docker compose up` clean, migrations +
tables confirmed, backend `/health` responds, frontend loads and calls backend.

**Next:** authentication (PRD §8.1, data model §9A) — the first real feature.

## 2026-07-21 — Authentication feature (PRD §8.1, AUTH-1 through AUTH-7)

Scope for this pass: full auth lifecycle plus the minimum slice of §8.2 that AUTH-3/ORG-1
require (organization creation + Super Admin designation via `organization.createdByUserId`,
per data model §3 — Super Admin is not a role). Department creation, storage setup, user
directory management, and the rest of first-run onboarding are explicitly **not** built yet —
separate PRD sections, separate features.

**Backend** (`backend/src/modules/auth/`, `backend/src/lib/`, `backend/src/plugins/`):
- `POST /auth/register`, `/verify-email`, `/resend-verification` — AUTH-1, AUTH-2. Email
  verification blocks *use* of an organization, not its creation (2B.2) — enforced via the
  `requireVerifiedEmail` preHandler on org-scoped routes only, not on register/create-org.
- `GET /auth/signup-mode` (public), `POST /auth/organizations` — AUTH-3/ORG-1. Reads the
  singleton `signup_setting` row (seeded via `prisma/seed.ts`, mode=`invite_code` per launch
  default); validates against `signup_invite_code` when in that mode.
- `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all` — AUTH-4, AUTH-6.
  Access token is a short-lived JWT (15m default) carrying `sub`, `emailVerified`, and
  optionally `organizationId`/`isSuperAdmin` once an organization is selected. Refresh token is
  an opaque random value, httpOnly+SameSite=Lax cookie, hash-only in `refresh_token` (rotates on
  every use, per data model 9A.1). `POST /auth/select-organization` reissues an org-scoped access
  token without rotating the refresh token, for in-app org switching (AUTH-6, "several shows a
  picker, switch in-app"). A user's organization list = orgs they created (Super Admin) ∪ orgs
  reached via active `membership` rows.
- `POST /auth/forgot-password`, `/auth/reset-password` — AUTH-5. Forgot-password always returns
  an identical response whether or not the email exists (no enumeration). Reset revokes all of
  that user's `refresh_token` rows (data model 9A.2: "a reset logs other sessions out").
- Rate limiting (AUTH-7): Redis counter (`login:fail:*`, TTL-boxed) locks an email after
  `LOGIN_MAX_ATTEMPTS` (default 5) for `LOGIN_LOCKOUT_MINUTES` (default 15); every attempt is
  also durably logged to `login_attempt` for audit history.
- New libs: `lib/password.ts` (argon2id), `lib/tokens.ts` (raw/hash pair for all single-use
  tokens), `lib/jwt.ts`, `lib/mailer.ts` (dev-only console transport — logs the email body
  instead of sending; swap for Resend later behind the same `sendMail` interface, no caller
  changes needed).
- Assumption flagged, not in any doc: password minimum length set to 8 characters (Zod). The
  docs mention "password policy" as a requirement (PRD §12, Scope §3.7) but never specify a
  concrete rule — used a common-sense default rather than blocking on this.

**Frontend** (`frontend/src/pages/`, `store/authStore.ts`, `lib/api.ts`): Register, Login,
Verify-email (token-in-URL) + Verify-email-pending (resend/recheck), Forgot/Reset password,
Create-organization (adapts its invite-code field to the live `/auth/signup-mode`), Select-
organization, and a minimal authenticated Dashboard (replaces the old health-check placeholder
page, keeps a small health-check readout so the original scaffold proof-of-connection isn't
lost). `authStore` (Zustand) holds the access token in memory only — never persisted — with
`currentOrganizationId` cached in `localStorage` for UX continuity across reloads.
`AuthBootstrap` silently calls `/auth/refresh` + `/auth/me` on app mount to restore a session
from the httpOnly cookie. `apiRequest` auto-refreshes and retries once on a 401 for any non-
`/auth/*` call (future protected feature endpoints get this for free).

**Verified locally (direct API testing, curl):** register → verify-email (token pulled from the
dev-mailer console log) → create-organization (invite-code gate, seeded a test code directly in
Postgres since there's no admin UI for this yet) → login (single-org auto-select) → 5 failed
logins locks the account, 6th and a correct-password attempt both correctly rejected during
lockout → refresh (plain and org-scoped) rotates the refresh token → logout revokes it (refresh
afterward correctly fails) → forgot-password returns an identical message for a real vs. fake
email → reset-password rejects the old password and accepts the new one → duplicate
registration on the same email rejected → `/auth/me` and invalid-token rejection both correct.
Backend `tsc`/`eslint` clean; frontend `tsc -b`, `eslint`, and `vite build` all clean; confirmed
CORS + cookie headers are correct for a simulated request from the real frontend origin
(`Origin: http://localhost:5173`, credentials, httpOnly Set-Cookie all present).

**Not verified:** no interactive browser click-through — the user started installing the Chrome
extension but chose not to finish this session, so no `claude-in-chrome` tool was available.
Everything above was validated via direct HTTP calls to the backend and a clean production
frontend build, not by clicking through the UI.

**Also fixed:** a stray Vite dev server from an earlier session (running since 2026-07-14) was
still holding port 5173, forcing new dev servers to fall back to 5174 — which would silently
break CORS (configured for exactly `http://localhost:5173`, required for credentialed cookies).
Killed it; confirmed it was this project's own leftover process, not unrelated user work.

## 2026-07-21 — Manual browser test surfaced two real gaps, both fixed

User did the manual browser walkthrough (register → create-organization). Found:

1. **No invite code, no email — by design, but under-communicated.** The dev-only mailer
   (`lib/mailer.ts`) only logged emails to the backend terminal; nothing was ever actually sent,
   and there was no admin UI to generate an invite code for a first-time user to use. Gave the
   user the test code (`DEV-TEST-0001`, seeded directly in Postgres) and pointed them at the
   backend terminal for the verification link, as a stopgap.
2. **Real email needed.** User has a Brevo account and wants to send from `noreply@abateas.app`.
   Swapped the mailer's transport (interface unchanged, per the original design intent):
   `lib/mailer.ts` now calls Brevo's `/v3/smtp/email` API when `BREVO_API_KEY` is set in `.env`,
   falling back to the console logger when it's blank — so environments without a key (or CI)
   keep working unchanged. Added `BREVO_API_KEY` / `EMAIL_FROM` / `EMAIL_FROM_NAME` to
   `env.ts`/`.env`/`.env.example`. **`noreply@abateas.app` must be a verified sender/domain in
   Brevo**, or sends fail even with a valid key. User added their real API key to `.env` directly
   (not shared in chat, correctly gitignored).

   First live send attempt hit `TypeError: fetch failed: getaddrinfo ENOTFOUND api.brevo.com`
   — transient DNS failure from this machine's ISP resolver. Notably the **same failure mode**
   we hit earlier pulling `docker.io` images (see the Docker+Prisma entry above) — two
   independent outbound DNS lookups failing intermittently from this host is enough of a pattern
   to treat as a real environment characteristic, not a fluke. Added a bounded retry (3 attempts,
   300ms/900ms backoff) around the Brevo network call specifically — only for actual fetch
   failures (DNS/connection), not for real error responses from Brevo (bad key, unverified
   sender, etc.), which retrying can't fix and shouldn't mask. Confirmed: registration and
   resend-verification both send successfully now, no console-log fallback, no errors.

**Next:** either a manual browser walkthrough of the rest of the flow (verify → dashboard,
password reset, org switching), or the next feature — department creation (PRD §8.4) is the
natural follow-on once a Super Admin exists.

## 2026-07-21 — End of session: invite-code concept clarified, current DB state

User asked what the invite code actually *is* — clarified for the record since it'll matter
again later:

- `signup_mode` (table `signup_setting`, singleton row) is a **system-wide** switch, not
  per-organization and not per-user. It gates one specific action — *creating a brand-new
  organization* — via `open` / `invite_code` / `disabled` (spec 2B.2). It has nothing to do with
  ordinary login, or with joining an *existing* org (that's the separate, not-yet-built
  `invitation` flow for adding a member to an org/department).
- There is **no admin UI to generate invite codes** in this codebase yet — not scoped for
  Release 1 (no platform-admin surface is planned; see Scope doc). `DEV-TEST-0001` is not a real
  product feature — it's a row I inserted directly into `signup_invite_code` via `psql` purely so
  local testing wasn't blocked on that missing tooling. It has unlimited uses
  (`maxUses = null`) and should be treated as a throwaway dev credential, not a secret worth
  protecting — anyone with DB access can already see/use it.
- Given this is single-org internal software for now, switching local `signup_mode` to `open`
  (no code needed at all) is a reasonable option the user was offered and declined for now —
  revisit anytime by editing the `signup_setting` row.

**Current DB state at session end** (for tomorrow's pickup):
- 6 registered users; only `ada@example.com` (my own test account, org "Acme Corp") and
  `rpa@abateas.com` (user's account — email verified successfully via the real UI) have made
  meaningful progress. **No organization has been created via the actual browser UI yet** —
  the create-organization step through the real frontend is still unconfirmed.
- Invite code `DEV-TEST-0001` still active, unlimited use, `usedCount = 1` (only my own curl
  test has consumed it so far).
- Docker containers (`dms-postgres-1`, `dms-redis-1`) and both dev servers (backend :4000,
  frontend :5173) were left **running** at end of session — real Brevo emails send correctly
  from this backend instance if you keep testing without restarting it.

**Next when resuming:** finish the manual browser walkthrough — submit the create-organization
form as `rpa@abateas.com` using `DEV-TEST-0001`, confirm it lands on the dashboard, then password
reset and org-switching if there's appetite, before starting department creation (PRD §8.4).

## 2026-07-22 — Visual redesign of all auth/dashboard screens (presentation only, no logic changes)

User asked for a proper, modern, animated UI pass over everything built so far (the auth flow +
dashboard were plain slate/white Tailwind cards with no visual identity). Used the
`frontend-design` skill to pick a direction on purpose rather than reach for a template.

**Direction — "document registry / ledger":** justified by the product itself being a document
registry. Palette (`tailwind.config.js`): `ink` #182620, `paper` #F1EEE4, `surface` #FCFBF7,
`brass` #9C7A3C, `oxblood` #7E2E22, `moss` #3F5B4A. Type: Fraunces (display, used sparingly for
card titles), Inter (body/UI), IBM Plex Mono (step tabs, codes, timestamps, status lines) —
loaded via Google Fonts link in `index.html`. Page background is a faint dot-grid on paper.

**Signature elements:**
- Every auth card (`AuthCard.tsx`) is now a "ticket": a folder-tab sticking out top-left carries
  a mono step label (`Step 01 — Register`, `Step 02 — Verify`, `Step 03 — Organization`, or
  `Access Recovery` for the forgot/reset side-branch) — this doubles as a real step indicator
  since the auth flow genuinely is sequential. A perforated edge (`.ticket-perf` in `index.css`)
  runs under the tab. Inputs are underline "ledger-blank" style, not boxed.
- Added `StampSeal` component — an animated ink-stamp seal (`animate-stamp-in` keyframe: scale +
  rotate overshoot) used only on the two genuine confirmation moments that linger on-screen:
  email-verified success (`VerifyEmailPage`) and reset-link-sent (`ForgotPasswordPage`). Not used
  on pages that navigate away immediately, to keep it a real signature rather than decoration.
- `SelectOrganizationPage` and `DashboardPage` restyled in the same language (ticket card, mono
  status line, staggered fade-up on the org list) without using `AuthCard` directly, since their
  layouts differ (list vs. header).
- `prefers-reduced-motion` respected globally (`index.css`); all interactive elements keep
  visible `focus-visible` rings.

**No behavior changes** — every API call, validation rule, and navigation path is untouched;
only JSX/class names/copy microtext changed. Verified `tsc -b`, `eslint`, and `vite build` all
clean after the change. Not yet click-tested in a real browser this session (no `claude-in-chrome`
connection available) — the user's existing dev server on `:5173` picks up the changes via HMR,
so a manual look is still worth doing before calling this final.

**Next:** manual browser look at the new design, then resume the pending walkthrough item above
(department creation, PRD §8.4) once the user's happy with the visuals.

## 2026-07-22 — Development roadmap written; graphify run over the whole repo

User asked for a full module-by-module build plan spanning start to end, to be kept updated as
each step completes — read all five spec docs fully and wrote `DEVELOPMENT_ROADMAP.md` at the
project root (checked-in, living checklist; `each_update.md` stays the detailed diary the
roadmap points back to). Order is dependency-driven: Org completion → Department creation →
Permission engine (its own module — cross-cutting, needed before any protected resource) →
Storage abstraction → Folders → Documents/Versioning → Upload/OCR → Search → Viewer → Sharing →
Confidential folders → Trash → Audit viewer → NFR hardening → Deployment. Release 2 items are
listed explicitly as "do not build yet" so a module never quietly grows into one.

**Notable discovery while reading the codebase for this:** `backend/prisma/schema.prisma` now
exists in full (all data-model entities, one migration applied) — the "doesn't exist yet, user
will add it" note from 2026-07-21 is stale. Also confirmed `AuditEvent` is not written anywhere
yet, including by the existing auth module — flagged as a real gap (Module 1.5 in the roadmap),
not just a documentation nit.

Also ran `/graphify` over the whole repo (58 files, ~43.6k words) — decompressed and grepped
`docs/.dc.html` for the earlier UI redesign was unrelated; this was a fresh full-repo knowledge
graph. AST extraction on the 46 code files (274 nodes/579 edges) ran in parallel with a semantic
subagent over the 11 real doc files (98 nodes/204 edges/3 hyperedges) — deliberately excluded
`docs/.dc.html` from semantic extraction since it's a compressed design-export bundle, not prose.
Merged graph: 372 nodes, 650 edges, 23 communities. Outputs in `graphify-out/` (`graph.html`,
`GRAPH_REPORT.md`, `graph.json`) — gitignored-adjacent working data, not part of the shipped app.

## 2026-07-22 — Module 1.1: Storage setup & test-connection (backend + frontend)

Built the first roadmap item end-to-end: `STO-1` through `STO-4`.

**Backend** (`backend/src/modules/storage/`): a `StorageDriver` interface (`testConnection`,
`put`, `get`, `delete`) with two implementations —
- `drivers/nas.driver.ts`: treats the configured `mountPath` as an **already-mounted** filesystem
  path (the ops team mounts the SMB/NFS share at the OS/container level) rather than the app
  opening its own SMB session. This was a real design ambiguity the Scope doc leaves open
  ("Mount path, credentials (SMB/NFS)" as inputs, no spec of *how* auth happens) — flagged here
  rather than silently picked, since a real SMB client in Node is heavy and orthogonal to what
  the round-trip test actually needs to guarantee. `username`/`password` are accepted and
  encrypted for the ops runbook but not functionally used by this driver; swapping to an
  active-mount driver later is a driver swap behind the same interface, not a rewrite.
- `drivers/r2.driver.ts`: AWS SDK v3 `S3Client` pointed at R2's endpoint (`region: "auto"`) since
  R2 is S3-compatible — added `@aws-sdk/client-s3` to `backend/package.json`.

Both drivers implement the exact four-step sequence from Scope doc §6.1.1 (connect → write →
read-back-and-compare → delete) and map real errors to the specific, actionable messages the doc
calls for (wrong path/share not mounted, no write permission, disk full, wrong keys, bucket
missing, can-write-but-not-delete, timeout) — never a generic "connection failed."

**Credentials encryption** (`backend/src/lib/crypto.ts`): AES-256-GCM with a symmetric key from
a new env var `STORAGE_CREDENTIALS_KEY` (32 random bytes, base64 — generated a fresh one for
local dev, added to `.env` and a documented-blank placeholder in `.env.example`). This was an
open item in the Data Model doc (§12, "credential encryption approach... to be settled with
deployment") — settled here with a standard symmetric-key-from-env approach; revisit if a KMS
becomes available at deployment.

**On failure, nothing is saved** — matches Scope doc §6.1.1 literally ("does not save the
configuration"): `testAndSaveStorageConfig` only touches the `storage_config` row after
`testConnection()` returns success; a failed attempt just returns the mapped error and leaves
the org's existing config (or lack of one) untouched.

**Audit logging groundwork** (`backend/src/lib/audit.ts`): a small `logAuditEvent()` helper,
append-only by construction (only exports a create — no update/delete path is even reachable
from this module, matching CLAUDE.md's hard rule). Wired into the storage-config save action
(`config_change`). **Not yet retrofitted into the existing auth routes** (register, login, org
creation, password reset) — that's still open, noted in the roadmap.

**Routes**: `GET /storage/config` (status only, no credentials, `BigInt` fields converted to
strings since Fastify's default JSON serializer can't handle `BigInt`) and `POST /storage/config`
(Super-Admin-only — checked via `request.user.isSuperAdmin`, the same flag the auth module
already sets at login/org-selection time; no new role concept needed).

**Frontend**: `StorageSetupPage.tsx` — backend-type toggle (R2/NAS), fields adapt to the choice,
"Test & save connection" does both atomically, current status shown if already configured. Wired
into `App.tsx` at `/storage-setup` (protected, verified+org-required). Added a storage-status
banner to the Dashboard for Super Admins with a link to configure/manage it.

**Verified locally:**
- `tsc`/`eslint` clean on both backend and frontend; `vite build` clean.
- Minted a short-lived JWT directly (same `JWT_ACCESS_SECRET`, no UI login needed) for the
  existing `rpa@abateas.com` / "Abate" org (already Super Admin, real DB row) to hit the API
  directly, since I don't have that account's password.
- NAS driver: a bogus path correctly fails at the connect step with "Mount path not found —
  check the path and that the share is mounted."; a real writable directory correctly passes
  all four steps, the config saves as `verified`, and the test file is cleaned up (directory
  empty afterward).
- Confirmed in Postgres: `storage_config.credentials` holds only opaque ciphertext (the real
  mount path never appears in plaintext in the DB), and the `config_change` audit event was
  written correctly.
- Removed the test `storage_config` row and its audit event afterward via a direct Prisma script
  (not through app code — there is no delete path in the app itself) so the real "Abate" org
  isn't left with throwaway test data.
- **Not yet tested:** the actual frontend form through a browser (no `claude-in-chrome`
  connection this session) — only the API directly and a clean production build.

**Next:** per `DEVELOPMENT_ROADMAP.md`, either finish out the rest of Module 1 (org settings,
user directory, first-run onboarding wiring, thin dashboard) or move to Module 2 (department
creation) — storage setup was the highest-value blocker and is now clear.

## 2026-07-22 — R2 test-connection: root cause was the R2 API key itself

User hit "access key or secret is incorrect" on first R2 attempt. Two things were fixed
speculatively at once (the checksum-header incompatibility between recent AWS SDK v3 versions
and R2 — see `r2.driver.ts`'s `requestChecksumCalculation`/`responseChecksumValidation` — plus
added server-side error logging), but user confirmed afterward the actual root cause this time
was the R2 API access key itself (regenerated/corrected on the Cloudflare side). **Kept the SDK
checksum fix anyway** — it's a real, independently-documented compatibility issue that will
misreport as a credentials error for anyone on a recent SDK version, so it's worth having fixed
regardless of what actually caused this specific instance. R2 storage is now connected and
verified for the "Abate" org.

Module 1.1 (Storage setup & test-connection) is confirmed working end-to-end against real R2
credentials, not just the local NAS-path test from earlier today.

## 2026-07-22 — Module 1.2 (Organization settings) + 1.3 (User directory, partial)

**1.2 — Organization settings, complete.** New `backend/src/modules/organization/` module:
`GET/PATCH /organizations/current` for `name`/`industry`/`subfolderDepthLimit`, gated by a new
`app.requireSuperAdmin` Fastify decorator (added to `plugins/authenticate.ts` alongside the
existing `requireOrganization`, and used to simplify `storage.routes.ts`'s inline Super-Admin
check too). Every settings change writes a `config_change` audit event. Frontend:
`OrganizationSettingsPage.tsx`, linked from the Dashboard.

**1.3 — User directory, built what's real, deferred what isn't.** Before writing code, worked
through what `ORG-2`/`ORG-3` actually require: `Membership` (the join that represents "a user in
this org") and `Invitation` both have **required** `departmentId`/`roleId` foreign keys — and
Module 2 (Department creation) doesn't exist yet, so there are zero departments/roles anywhere
in the system right now. That means "invite a user to a department with a role" has nothing to
target today; building that form now would just be an empty dropdown with no way to test it.

Split the scope accordingly:
- **Built now:** `GET /organizations/current/members` (lists the Super Admin — via
  `organization.createdByUserId`, not a `Membership` row, per Data Model §2.4 — plus anyone with
  an active `Membership` in the org), disable/enable (flips every `Membership` the target user
  holds *within this org only* — deliberately never touches the global `User.status`, matching
  Data Model §7.3's "disabling in Org A doesn't affect Org B"), reset-password (reuses the
  existing `authService.forgotPassword` flow, just checks the target is actually a member of
  this org first). Guardrail: the org's Super Admin can't be disabled — there's no platform-level
  admin in this design who could ever restore them (Feature Spec §2.2).
- **Deferred, flagged, not built:** invite-to-department, accept-invitation, remove-from-
  department. These need Module 2 to exist first. Noted clearly in `DEVELOPMENT_ROADMAP.md`
  under 1.3 so this isn't mistaken for an oversight later.

Frontend: `UserDirectoryPage.tsx` — member list with per-department role/status, disable/enable
and reset-password actions, an empty-state note explaining why invites aren't here yet.

**Verified locally against the real "Abate" org** (same JWT-minting-for-testing approach as the
storage module, since I don't have `rpa@abateas.com`'s password):
- GET/PATCH org settings — patched `subfolderDepthLimit` from 5→7, confirmed the response, then
  reverted it back to 5 so the real org isn't left altered.
- Member list correctly showed only the Super Admin (no departments exist, as expected).
- Attempting to disable the Super Admin correctly 400'd with `cannot_modify_super_admin`.
- Seeded a **throwaway** department + role + membership directly via Prisma (attached to the
  existing `ada@example.com` test user, not a real person) purely so disable/enable/reset-
  password had something real to act on — listed, disabled, re-enabled, reset-password'd, all
  correct, then deleted the throwaway department/role/membership and their audit events
  afterward so "Abate" isn't left with fake data.
- Confirmed all four actions (org update ×2, disable, enable, reset-password) wrote the correct
  audit events with the right `action` enum value and description.

**Unrelated bug found and fixed while testing:** a PowerShell test request without a body hit
Fastify's own `FST_ERR_CTP_INVALID_MEDIA_TYPE` parsing error, which the global error handler in
`app.ts` was flattening to a generic `500 internal_error` — hiding the real `415`. This wasn't
specific to the new code (the same gap existed for malformed-JSON bodies during the storage
testing session too); fixed once, generally: the handler now surfaces any Fastify error's own
`statusCode` when it's in the 4xx range, before falling back to a genuine 500. Confirmed the
same request now correctly returns 415.

**Not yet tested:** the two new frontend pages through an actual browser (still no
`claude-in-chrome` connection this session) — only the API directly and clean production builds
(`tsc`, `eslint`, `vite build` all clean on both backend and frontend).

**Next:** per `DEVELOPMENT_ROADMAP.md`, remaining Module 1 items are 1.4 (first-run onboarding
wiring), the rest of 1.5 (retrofit audit logging into the original auth routes), and 1.6 (thin
org dashboard with department/user/document/storage counts) — or jump to Module 2 (department
creation), which would also unblock finishing 1.3's invite flow.

## 2026-07-22 — Module 1.6: Organization dashboard (thin)

`GET /organizations/current/dashboard` (Super-Admin-gated, added to `organization.service.ts`/
`organization.routes.ts`): department count, user count (distinct active-membership user IDs +
the Super Admin, who isn't a `Membership` row), document count, org-wide storage used bytes
(from `StorageConfig.usedBytes`), live storage connection status, and a per-department
member/document count breakdown. Confidential-folder documents are deliberately **included** in
every count (no `is_confidential` filter anywhere in these queries) since Feature Spec §10A's
rule is "counts, never contents" — a bare number exposes no name, so there's nothing to exclude.

**Flagged gap, not silently resolved:** Feature Spec §10A describes per-department "member,
document *and storage*" counts, but the Data Model only models storage at the organization
level in R1 (`storage_config` is one row per org; per-department storage is explicitly listed
as R2 in Data Model §11). There's no field to source a per-department storage number from, so
it's omitted from the department list rather than made up. Noted in the roadmap in case this
becomes a real requirement before R2.

Frontend: folded straight into `DashboardPage.tsx` rather than a separate page, since the
Feature Spec describes this as *the* Super Admin landing screen, not a screen you navigate to —
four stat tiles, a department list (with an honest empty state until Module 2 ships
departments), and the existing storage-status banner now sources from this one dashboard call
instead of a separate `/storage/config` fetch.

**Verified locally** against the real "Abate" org: `{departments: 0, users: 1, documents: 0,
storageUsedBytes: "0"}`, storage correctly showing `r2`/`verified` from the earlier real R2
test — all genuinely correct for the org's current state, not placeholder data. `tsc`/`eslint`/
`vite build` clean on both sides.

Module 1 status: 1.1, 1.2, 1.3 (partial, by design), and 1.6 are done. Remaining: 1.4
(first-run onboarding wiring) and finishing 1.5 (retrofitting audit logging into the original
auth routes — register/login/password-reset still don't write audit events).

**Next:** 1.4, the rest of 1.5, or Module 2 (department creation) — Module 2 is the one that
unblocks the deferred half of 1.3 (invite/remove) and everything after it.

## 2026-07-22 — Module 1.4 (first-run onboarding) + 1.5 (finish audit-logging retrofit) — Module 1 complete

**1.5 first, since it narrowed 1.4's scope.** Went back through every function in
`auth.service.ts` to see what could actually be audit-logged, given `audit_event.organization_id`
is a required (non-nullable) FK. Conclusion: only `createOrganization` has both an organization
to attach to *and* a matching `AuditAction` value (`config_change`). Register, login,
`forgotPassword`/`resetPassword`, `verifyEmail`, `resendVerification` are all global-account
actions with no organization context — and login has no matching action enum value at all. This
isn't an oversight to fix later; it's what the Data Model actually specifies (§8: the audit
trail is an organization-scoped compliance surface, not a global account-activity log). Added
the one real retrofit — `createOrganization` now logs `config_change` / "Organization created" —
and corrected the roadmap's earlier note, which had assumed register/login/password-reset were
all still-open gaps before I'd traced through the FK constraint.

**Verified via the real HTTP endpoint**, not just a direct service call: minted a JWT for an
existing unverified test user (`it+brevotest@abateas.com`) with no `organizationId` claim, hit
`POST /auth/organizations` with the still-active `DEV-TEST-0001` invite code, confirmed the
`config_change` audit event was written for the new org, then deleted the throwaway org + its
audit event and decremented `DEV-TEST-0001`'s `usedCount` back down so the real invite code's
usage count stays accurate.

**1.4 — first-run onboarding.** `OnboardingPage.tsx`, a 3-step guided flow (Feature Spec §2B.4):
Storage (hard-gated, real) → First department (placeholder) → Invite people (skippable
placeholder). Extracted the storage form out of `StorageSetupPage` into a shared
`StorageConnectionForm` component so both the onboarding step and the standalone settings page
use the same code. Steps 2 and 3 are honest stubs, not fake buttons — they say plainly that
department creation isn't built yet, same dependency already flagged for 1.3's invite flow.

**Routing detail worth remembering:** `CreateOrganizationPage` now sends verified Super Admins
to `/onboarding` instead of `/`. But the *first* time many Super Admins actually reach a "verified
and organization exists" state is via `VerifyEmailPendingPage`'s `checkVerified()` — someone who
registers, creates their org while still unverified (allowed; verification blocks *use*, not
*creation*, per Feature Spec §2B.2), then verifies afterward. That path was still hardcoded to
`navigate("/")`, which would have silently skipped onboarding for what's probably the *more*
common ordering. Fixed it to route to `/onboarding` when the newly-verified user has exactly one
organization and is its Super Admin — safe to do unconditionally there since email verification
tokens are single-use, so this branch only ever fires once per account, never on a later login.
Also added a defensive guard directly in `OnboardingPage` (redirects non-Super-Admins to `/`) in
case the route is ever reached directly, since every step in the flow is a Super Admin action.

**Verified locally:** `tsc`/`eslint`/`vite build` clean on both sides. Did not re-test the full
click-through onboarding flow in a browser this session (still no `claude-in-chrome`) — the
storage step reuses already-tested code, and the routing logic was traced by hand rather than
clicked through.

**Module 1 is now fully complete** (1.1 through 1.6), with one deliberately deferred piece:
1.3's invite-to-department/remove-from-department, blocked on Module 2 as noted earlier.

**Next:** Module 2 (Department creation) — the five-step wizard, schema builder, templates,
vocabulary, and role/rule defaults. This is also what unblocks the deferred half of 1.3 and
lets Onboarding's steps 2/3 become real instead of placeholders.

## 2026-07-22 — Design pass: full-screen app shell, industrial/dense layout

User shared a reference screenshot (dark-mode dashboard: stat tiles, a department table with
sector icons, a storage panel with a progress bar, a quick-actions panel) and asked for a denser,
full-screen "industrial" pattern instead of the small centered cards used so far — applied to
Dashboard and the other authenticated app pages (Organization Settings, Storage Setup, User
Directory), not just the dashboard. Asked first whether to also switch to dark mode to match the
reference exactly, or keep the light "Keystone" palette and only adopt the structural pattern —
user chose to **keep the light palette**, so no color-token changes here, purely layout/structure.

**New `AppShell` component** (`frontend/src/components/AppShell.tsx`) — a persistent left
sidebar (org name + Super Admin pill, nav links, user info + sign-out at the bottom) plus a
full-width main content area (`max-w-[1400px]` centered so it doesn't stretch absurdly on an
ultra-wide monitor, but fills a normal desktop screen). This is a deliberate improvement over the
reference, not a copy of it — the reference has no sidebar at all (just a lone "Settings" button
top-right), but since this app already has three distinct admin screens (org settings, storage,
user directory) with more coming (departments, etc.), a persistent nav is the more scalable
"industrial SaaS" pattern (Linear/Vercel/Notion-style) than a single mega-page. Auth pages
(Login/Register/etc.) and the Onboarding wizard deliberately keep their existing centered-card
style — they're pre-app/one-time flows, not persistent app screens, so the shell doesn't apply.

**New icon set** (`frontend/src/components/icons.tsx`) — minimal stroke SVGs (grid, gear, users,
database, logout, chevron, folder, check-circle) matching the existing `Logomark`'s visual
style, used throughout the shell and the redesigned pages instead of text-only buttons.
`Logomark` itself is now exported with a `size` prop (was a private, fixed-size function inside
`AuthCard.tsx`) so the sidebar can use a smaller version of the same mark.

**Dashboard** rebuilt around the reference's pattern: four stat tiles (bigger and roomier now
that there's a full-width page instead of a cramped card), a real `<table>` for departments
(icon + name, member/doc counts, honest empty state — no fake "+ New department" button since
Module 2 doesn't exist to back it), and a two-panel row (Storage status + progress-free usage
figure since `quotaBytes` isn't set anywhere yet so a fake progress bar would be dishonest;
Quick actions as icon+label link rows). Dropped the reference's redundant top-right "Settings"
button since the sidebar already provides that navigation.

**Organization Settings, Storage Setup, User Directory** — same shell, page header pattern
(title + subtitle), form content in a constrained `max-w-xl` card (not stretched edge-to-edge —
enterprise settings pages read better at a fixed form width even inside a full-width page), and
User Directory's member list became a proper table matching the Dashboard's department table
styling, for visual consistency between the two list-type screens.

**Verified:** `tsc`, `eslint`, `vite build` all clean on the frontend after the refactor. Did
not re-verify any backend behavior since zero backend/query logic changed — this was purely a
layout/component refactor around the same API calls already tested in earlier sessions. Not
click-tested in an actual browser this session (still no `claude-in-chrome` connection) — dev
server is running and picks up the changes via HMR (no config files touched, so no restart
needed this time) if a manual look is wanted.

**Next:** Module 2 (Department creation) is still the natural next step — it will also give the
new Departments table and the Onboarding wizard's stub steps something real to show.

## 2026-07-22 — Design pass 2: reference-matched dashboard, two-card storage picker, bigger everything

User shared a closer reference mockup (a ChatGPT-generated image, visually very close to what was
already built — colored icon-bubble stat tiles with subtext, a table-style Departments panel with
a dashed-circle empty state + "Get notified" CTA, a Storage panel with a progress bar, a
chevron-style Quick actions panel, sidebar with an avatar) and asked to build "exactly like this,"
plus redesign the Storage page's backend picker as two big selectable cards instead of the small
segmented toggle. Clarified the earlier "unnecessary sidebar option" complaint directly this time:
the sidebar should only list **Overview** — Organization settings, User directory, and Storage are
reachable from the Overview page's own Quick Actions/Storage panel, so keeping them in the sidebar
too was pure duplication.

**Sidebar simplified to one nav item** (`AppShell.tsx`): just Overview. Removed the
Super-Admin-conditional nav-item logic entirely since there's nothing left to condition. Also
widened the sidebar (w-64 → w-80), bigger logo/avatar, avatar now shows the user's initials in a
solid indigo circle instead of just name/email text.

**New color tokens** (`tailwind.config.js`): `info`/`info-tint` (blue, for the Documents stat
tile) and `accent`/`accent-tint` (amber-orange, for the Storage stat tile and a decorative
background shape) — kept semantically distinct from `warning` (which still means "something's
wrong"), since these two are purely categorical/decorative.

**New icons** (`icons.tsx`): `DocumentIcon`, `BellIcon`, `BoltIcon`, `ChevronRightIcon`,
`CloudIcon` (for R2, distinct from NAS's server-stack `DatabaseIcon`).

**Dashboard**: stat tiles now have colored icon-bubbles + a subtext line under each number
("No departments yet" / "Active users" / etc.), a static (non-interactive, so it never promises
a menu it doesn't have) today's-date badge top right, a real dashed-circle empty state for
Departments with a "Get notified" button. That button is intentionally honest — no backend call,
no claim of an actual email/push notification; clicking it just flips to a local acknowledgment
("We'll flag it right here") since there's no notification system in this app at all (that's a
Release 2 item) and CLAUDE.md's spirit is to never fake capability. Storage panel now shows a
real usage line ("X used of storage", no fabricated quota total since `quotaBytes` is never set
anywhere yet) with a progress bar. Backend-connection footer restyled with a connected-dot +
separator + timestamp row.

**Storage backend picker rebuilt as two big cards** (`StorageConnectionForm.tsx`): Cloudflare R2
and NAS, each with an icon, one-line description, and a selected state (indigo border + tint +
checkmark badge) replacing the old small segmented toggle — matches what was asked for directly,
and reads as a much more deliberate choice than a toggle switch.

**Sizing pass, "make it bigger" applied everywhere**: sidebar width, all card `border-radius`
(xl → 2xl), all card padding (p-5/p-6 → p-6/p-7/p-8), stat tile numbers (26px → 32px), page
titles (24px → 28px), table cell padding, form-card max-widths (org settings xl → 2xl, storage
2xl → 3xl, onboarding lg → 2xl to fit the two-card picker comfortably). Added a real soft shadow
(`shadow-[...16px 36px -16px rgba(26,28,30,0.18)]`, defined once as `CARD_SHADOW` in
`DashboardPage.tsx` and inlined elsewhere) to every card that didn't have one — the shell redesign
had gone flatter than intended.

**Background decoration for the content area** (`AppShell.tsx`'s new `BackgroundDecoration`): a
subtle indigo dot-grid (matching the brand color, not just generic gray), two soft blurred glow
blobs (indigo + blue), and two faint large outlined shapes (a ring motif and a rounded-square
motif) tucked into corners — all `pointer-events-none`, `aria-hidden`, and low-opacity enough
(5–12%) that they read as texture/depth behind the opaque white cards rather than competing with
content. Scoped to `AppShell`'s main content area only, not the global `body` style the auth
pages use, so it doesn't affect Login/Register/etc.

**Verified:** `tsc`, `eslint`, `vite build` all clean. Did a full manual read-through of the
final `DashboardPage.tsx` JSX to check structural coherence (conditional branches, closing tags,
tone-map keys) since I still don't have `claude-in-chrome` this session to actually look at it
rendered. This is now the second design iteration built without a visual check — worth doing a
real click-through soon to catch anything a read-through can't.

**Next:** still Module 2 (Department creation) functionally, but a live browser look at this
design pass would be good before going further — several rounds of layout changes without ever
seeing it rendered is a real risk at this point.

## 2026-07-22 — Redesign, take two: replaced with the real "Keystone DMS" reference palette

User rejected the ledger/ticket/stamp direction outright ("the worst") and pointed at a Claude
design-artifact export (`claude.ai/design/p/...`, named "Keystone DMS") to use for color/theme.
The link itself 404/403'd for me (not a fetchable `claude.ai/code/artifact/{uuid}` URL, and not in
this account's shared-artifacts list) — user exported it as `docs/.dc.html` (a Claude "dc" bundle:
compressed JS + an inline HTML string, not plain CSS) instead. Decompressed/grepped it directly
(node, gzip+base64 decode of the embedded resource, then regex over the raw HTML/CSS string) to
pull out the actual design tokens rather than guessing from the visual style alone.

**Extracted from the reference:** body bg `#e7e5df`, app canvas `#f0eee6`/`#faf9f5`, card surface
`#fff`, borders `#e2e0d8`/`#eceae2`, text `#1a1c1e` (primary) / `#5a5e66` (secondary) / `#8a8d92`
(tertiary), primary accent `#3d3bd4` (hover `#2a289e`), status tints — success `#e3fbea`/`#177245`,
warning `#fff3d6`/`#8a5a00`, danger `#fde2e2`/`#b42318`. Font: IBM Plex Sans (UI/body) + IBM Plex
Mono (tags/meta only) — no serif anywhere in the reference. Controls use 7–9px radius, cards
~12px+, pills fully rounded; headings are bold with tight negative letter-spacing (e.g. 26px/700/
-0.5px); primary buttons carry a colored shadow tinted to the accent, not a plain black one.

**Rebuilt entirely on this system** (`tailwind.config.js`, `index.css`, `index.html` fonts,
`AuthCard.tsx`, all 9 pages) — dropped the ticket/tab/stamp motif completely in favor of: a plain
white rounded card on a soft warm-grey canvas with a faint indigo radial glow, a small indigo
logomark, a slim 3-segment progress bar for the real onboarding sequence (register → verify →
create org) instead of a tab label, boxed inputs with an indigo focus ring, and a green
check-icon (`SuccessIcon`) for the two genuine confirmation moments (email verified, reset link
sent) instead of the old ink-stamp. `StatusPill` now covers Super Admin (indigo tint) and future
document-state badges (success/warning/danger tints) in one component.

Verified `tsc -b`, `eslint`, `vite build` clean, and the compiled dev CSS resolves the new
tokens with no unknown-class errors. Dev server on `:5173` restarted (same stale-postcss-cache
issue as before whenever `tailwind.config.js` changes — needs a hard restart, HMR alone doesn't
re-init the Tailwind color palette). Still not click-tested in a real browser this session.

**Note to self for next design pass:** when the user references an external design/link again,
ask up front for an exported static HTML/CSS file or screenshots rather than assuming the link is
fetchable — `claude.ai/design/...` and other non-artifact claude.ai paths are not covered by the
WebFetch same-origin exception, and Claude "dc.html" exports are compressed JS bundles, not plain
markup, so they need to be decompressed (gzip+base64) before the colors/fonts are visible to grep.

## 2026-07-23 â€” Module 2: Department creation (five-step wizard, schema builder, roles) â€” backend + frontend

The first module where a real workspace object gets created. `DEP-1` through `DEP-4`, plus the
role/permission editor that Module 2.5 will later generalize.

**Permission catalogue as shared code** (`backend/src/lib/permissions.ts`): the fixed key set from
Data Model Â§3, grouped per Feature Spec Â§2A.4, with the dependency map from Â§2A.7, plus
`applyPermissionDependencies` / `findDependencyViolations` / `hasDepartmentAdminCapability`.
Served to the client at `GET /departments/permission-catalogue` so the role editor renders exactly
the catalogue the server validates against and can't drift from it. Deliberate split of
responsibility: the **client** auto-ticks a parent when you tick a child (a UI affordance), the
**server refuses** an invalid combination rather than silently repairing it â€” Feature Spec Â§2A.7
says the editor "must refuse to save an invalid combination rather than silently coercing it", so
a hand-crafted request can't sneak past the UI's helpfulness.

**Three flagged gaps, none silently resolved:**
1. **Step 5 (rules) has nowhere to be stored.** Feature Spec Â§3 Step 5 wants auto-tagging and
   default-sharing rules per department, and templates are described as bundling them â€” but
   `department` in the Data Model has no rules field, and no rules table exists. Built steps 1â€“4
   fully; step 5 is an honest screen explaining the storage decision is open (and that retention/
   expiry/workflow are Release 2 anyway). **This needs a decision â€” see the roadmap's 2.6.**
2. **"Department Admin" has no catalogue key.** The docs treat it as a capability level and as an
   undeletable system role, and Â§2A.4's example matrix even shows a "Create roles" row â€” but the
   Data Model Â§3 catalogue has no role-management key at all. Rather than invent one, the
   capability is derived from holding both `members.change_role` and `configuration.edit_rules`
   (one constant, `DEPARTMENT_ADMIN_CAPABILITY_KEYS`, documented at the definition site).
3. **`documents.restore` "requires access to Trash"**, per the dependency rules â€” but there is no
   trash key in the catalogue. Mapped to `documents.view` as the weakest defensible parent, to be
   revisited in Module 11.

**Templates** (`department.templates.ts`): the six shipped presets (Healthcare, Education,
Accounts, HR, Legal, Blank) as plain data â€” document types, fields, vocabulary and starter roles.
Kept as data, never branching logic, so R2's "save a department as a template" (DEP-5) can produce
the same shape without a rewrite. Starter roles: Department Admin gets every **R1-active** key â€”
deliberately *not* the Release 2 workflow/reports keys, since granting a permission that does
nothing today would silently confer approval authority the day R2 turns workflow on. Staff/Manager/
Auditor sets follow the doc's own Auditor pattern (view audit **without** export audit).

**Backend** (`backend/src/modules/department/`): `GET /departments`, `GET /departments/:id`,
`POST /departments` (Super-Admin-only, transactional â€” department + roles + document types +
fields + the creator's Department-Admin membership all in one `$transaction`), `PATCH
/departments/:id`, document-type CRUD, role create/copy/update/delete, member add/change-role/
remove. Every state-changing action writes an audit event (`config_change`, `role_change`,
`permission_change`, `member_change`).

Guardrails implemented and tested: exactly one title field per document type; unique field labels
within a type; dropdown fields must carry options and non-dropdowns must not; unique document-type
name + ID code per department; unique department name and **ID prefix per organization**
(enforced at the app layer â€” not a DB constraint, but two departments sharing a prefix would make
`DEPT-TYPE-YYYY-NNNNN` ambiguous about its origin); at least one Department-Admin-capable role at
all times (blocked on role edit, role delete, member role change **and** member removal); system
roles undeletable; a role still held by members can't be deleted; a field with values on real
documents can't be removed; the last document type can't be deleted; changing the ID prefix never
rewrites IDs already issued (documented in the UI, since document IDs are immutable).

`assertDepartmentPermission()` is a **first, narrow slice** of the effective-permission rule â€”
Super Admin bypasses the chain, everyone else resolves through their single membership's role.
Folder overrides and confidential folders are *not* handled there because neither exists yet;
Module 2.5 subsumes this function and must keep the baseline-then-restrict ordering.

**Frontend**: `DepartmentCreatePage` (the five-step wizard), `DepartmentsPage` (list),
`DepartmentDetailPage` (Overview / Document types / Roles / Members tabs â€” the "everything stays
editable afterwards" half of DEP-1), and two reusable editors â€” `DocumentTypeEditor` (drag-to-
reorder fields, per-field type/required/filterable/title controls, live sample document ID) and
`RoleMatrixEditor` (role chips with copy/rename, the full permission matrix, dependency-aware
ticking). Sidebar gained a second nav item (Departments) â€” a genuine top-level destination, not a
settings screen, so it doesn't reintroduce the duplication the sidebar was trimmed for earlier.
Dashboard's departments panel now links to the real wizard (the placeholder "Get notified" button
is gone), and Onboarding step 2 is real.

**Verified â€” API first, then a real browser walkthrough** (the Chrome extension was connected this
session, the first time since the design passes):
- Backend: 25+ direct API assertions covering every guardrail above, both success and failure
  paths, plus a **non-Super-Admin** run â€” a user holding only `Staff` could read the department but
  was correctly 403'd on creating a document type, creating a role, renaming the department,
  editing vocabulary, and creating a department; a cross-tenant department ID returned 404, not
  403 (no existence leak). Audit events confirmed in Postgres with the right action enums.
- Browser: walked all five wizard steps as the real Super Admin, created a department, landed on
  its detail page, confirmed the creator was auto-assigned Department Admin, and saved the
  document types back through the UI ("Document types saved.", no console errors). Also confirmed
  live that unticking a parent permission cascades to its children and that re-ticking the parent
  does **not** silently restore them.
- `tsc`/`eslint`/`vite build` clean on both sides.

**Four defects the browser check caught that a read-through never would have** (three pre-existing,
from the earlier design passes that were never looked at in a browser):
1. **A decorative background shape rendered as a solid black square** over the bottom-right of
   every app screen. Cause: `text-accent/[0.06]` â€” when that colour-with-opacity class isn't in
   the compiled stylesheet, the SVG stroke falls back to `currentColor` at full strength. Fixed by
   applying opacity as its own `opacity-[0.06]` utility, which can't fail that way. (Same pattern
   changed on the ring motif so it can't regress there either.)
2. **`w-auto` never overrode `primaryButtonClass`'s `w-full`** â€” both are single-class utilities of
   equal specificity, so stylesheet order decided it, and every "small" button silently rendered
   full width. Split into `primaryButtonBase`/`secondaryButtonBase` (no width) with the `*Class`
   variants adding `w-full` for the auth cards, and documented why at the definition.
3. The department subtitle lower-cased the configured identifier, printing "identified by employee
   id" for "Employee ID" â€” terms are now shown exactly as the admin typed them.
4. The subfolder-depth input was too narrow for its own placeholder ("Organization defau"), and
   moving between wizard steps kept the previous scroll position (jumping from the long permission
   matrix to a short step landed below the heading).

**Test data cleaned up**: both departments created during testing (one via API, one via the
browser) were removed from the real "Abate" org afterwards, along with their roles, document types,
fields, memberships and audit events â€” the org is back to zero departments, exactly as it was.

**Next:** Module 2.5 (the permission engine proper) is the roadmap's next item and the thing every
protected resource downstream depends on. Also now unblocked: 1.3's deferred invite-by-email flow,
since real departments and roles finally exist to invite people into.


## 2026-07-23 â€” Module 2.6 (department rules) and Module 2.5 (the permission engine)

Two follow-ons in the same session, both after decisions from the user.

### 2.6 â€” department rules, unblocked by a schema decision

User chose the `rules` JSON column over a `department_rule` table. Order of work was deliberate:
**the Data Model doc was updated first**, then the schema followed it â€” the doc governs field
names, so adding a column ahead of it would have inverted that.

- `docs/DMS_Data_Model.md` Â§2.4 gains a `rules | json` row plus a note stating the R1 shape and the
  reasoning (read as a whole at upload/share time, never queried or joined on â€” the same argument
  that already justifies `role.permissions` being JSON).
- Migration `20260723123008_department_rules` â€” one nullable JSONB column, applied cleanly.
- Shape in R1: `{ defaultSharing: { externalLinksEnabled, linkExpiryDays } }`, Zod-validated
  (`linkExpiryDays` capped at 365, booleans strict). Absent rules resolve to the documented
  defaults rather than null, so every caller sees one shape.
- **Auto-tagging is still not built, and now for a sharper reason than "nowhere to store it":**
  both halves have no target. A tag label has no column on `document` at all, and folder-conditioned
  rules need folders, which are Module 4. It becomes another key in the same JSON when either
  lands â€” not a schema change. Said plainly in the UI rather than shown as a dead switch.
- Templates carry their sharing default: every one starts closed except Legal, straight from
  Feature Spec Â§3 Step 5 ("HR and Medical keep external sharing off; Legal may enable it for
  auditors"). The default matters more than the exception because it applies to the documents
  nobody configures.
- Frontend: `RulesEditor`, shared by the wizard's step 5 and a new **Rules** tab on the department
  page. Verified in the browser against a test department â€” the tab showed the values written by
  the API, and both invalid-type and out-of-range rule payloads were rejected with field errors.

One deliberate constraint written into the copy and the engine both: this setting can *close* the
door, never open one a role has shut. A permissive rule never grants what a role lacks.

### 2.5 â€” the effective-permission engine

`backend/src/lib/effective-permissions.ts` is now the only place the resolution rule exists:

1. the user's single role in the department sets the baseline,
2. folder overrides may only restrict â€” never grant â€” and every override on the path applies,
3. a confidential folder ignores both: named list only, **Super Admin excluded**.

Details worth remembering:
- **Confidentiality is resolved by walking the folder chain**, not by trusting a folder's own
  `isConfidential` flag. A subfolder of a confidential folder is confidential even if its own flag
  is false, and the named list is read from the *nearest confidential ancestor* â€” the folder where
  the boundary was actually drawn. (Module 4 should still set the flag on descendants at creation;
  the engine just doesn't depend on it having happened.)
- **Overrides intersect.** Because they can only take away, order across the chain is irrelevant â€”
  which is exactly what makes "strictest wins" well-defined rather than a race between rows.
- **Super Admin bypasses steps 1 and 2 but is inside step 3.** Folder overrides are part of the
  departmental chain they sit outside of; the confidential exclusion is the one place they cannot
  reach, and it's checked before the member lookup so nothing below can short-circuit it.
- **External links are forced off inside confidential folders** at the engine level, not only in
  the sharing module â€” Â§11.2 says a confidential document can never leave by link, so it shouldn't
  depend on which caller asks.
- **Flagged decision:** the docs define the confidential named list as an access gate but never say
  which *capabilities* being named confers. Implemented as: the member's own department role where
  they have one, and a documented read-only floor (view/preview/download/version history/search)
  where they don't â€” being on the list has to grant something, and inventing a full set would be
  worse. Both paths still have external sharing forced off.
- `confidentialFolderIdsToExclude()` gives listing/search/count queries the ids to filter at the
  **query layer**, per the hard rule that this is never left to the UI. It returns ids rather than
  filtering counts itself, because aggregate counts legitimately include confidential folders
  (Data Model Â§8.1 â€” "the count is visible, the contents are not").
- `app.requirePermission("documents.upload")` is now a one-line Fastify preHandler, resolving the
  department/folder from route params or body and caching the resolution on the request so a
  handler can shape its response without resolving twice. Its 403 is deliberately identical whether
  you lack the permission, aren't a member, or are looking at a confidential folder you're not
  named on â€” a distinct error would leak the folder's existence.
- Module 2's `assertDepartmentPermission()` now **delegates** to the engine instead of keeping its
  own narrow copy, as the roadmap required. The local resolution logic is gone, not duplicated.

**Tested hard, as the roadmap demanded** â€” `npm run check:permissions` (backend), kept as
`backend/scripts/check-permission-engine.ts` rather than thrown away: **24 assertions, all
passing**, run against a real database with a throwaway fixture (department, three-level folder
tree, a confidential folder with a non-confidential-flagged child, overrides, named members) that
is deleted afterwards. Coverage includes: role baseline; non-member gets nothing; override
restricts; sibling folders unaffected; override inherited by descendants; **a fully permissive
override cannot grant beyond the role**; strictest wins across two overrides on one path; Super
Admin unaffected by overrides; confidential blocks a role holder who isn't listed; confidential
excludes Super Admin; confidential inheritance into a child whose own flag is false; named member
gets their role minus link/external; named member without a role gets the floor; a cross-tenant
department id resolves to nothing; and the query-layer exclusion list for member, non-member and
Super Admin. Route-level regression re-checked after the refactor (non-member 403, Super Admin
200). Backend `tsc`/`eslint` clean, frontend `tsc`/`eslint`/`vite build` clean.

No test runner exists in this project yet, so this is a script rather than a suite â€” noted at the
top of the file so it gets ported rather than rewritten when one is chosen.

**Note on the real org's data:** an "Accounts" department created through the browser during this
session is *not* mine â€” it was left completely untouched, including its vocabulary. Everything I
created for testing (two departments earlier, one for rules, one fixture for the engine checks) was
deleted afterwards.

**Next:** Module 3 (storage abstraction, mostly done in 1.1) then Module 4 (Folders) â€” folders are
what the engine's override and confidential paths currently have no UI for. 1.3's invite-by-email
flow also remains open and is now unblocked.


## 2026-07-23 â€” Palette rebuilt from the user's reference; storage screen reworked

### The palette (third attempt â€” see the note at the end)

User supplied a reference image: a four-colour "premium light theme" with each colour's role stated
on it. Built the token system directly from those four, keeping every colour in its assigned role:

| Reference | Hex | Role |
|---|---|---|
| Indigo Blue | `#3B5BDB` | primary actions, links, focus |
| Slate Gray | `#1E293B` | text, icons, headings |
| Warm Neutral | `#F6F3EE` | surfaces, cards, sections |
| Amber Gold | `#D4A017` | highlights, subtle emphasis |

Everything else in `tailwind.config.js` is derived from those four â€” tints, hovers, hairlines â€”
so nothing sits alongside them that wasn't asked for. Two judgement calls worth recording:

1. **The page is the warm neutral and cards are white, not the reverse.** A card is then *lifted
   out of* the page. This is the direct fix for "too much white": the previous version had white
   cards on a near-white canvas separated only by a hairline, so the screen read as one sheet.
2. **`accent-strong` (`#8A6410`) exists** because the gold at `#D4A017` on a light neutral is about
   2:1 contrast â€” fine as a fill, unreadable as text. Gold type uses the darkened variant.

**Why text looked blurry, and what actually fixed it.** Three causes, all addressed: body text was
a mid-grey rather than the full slate (now `#1E293B`); a 12%-opacity dot grid sat directly behind
body copy (the background wash is now masked to fade out well before the content column); and small
labels were 12px `font-medium` at low contrast (now 11.5px `font-semibold` with `0.08em` tracking,
which is what makes small caps hold their shape).

**The nesting rule, now explicit:** a card on the canvas is white; anything nested *inside* a card
is the warm neutral. Template tiles, storage backend cards, document-type lists and quick-action
rows were all white-on-white with a hairline, which is what made the wizard look flooded.

**Signature â€” the engraved plate** (`.plate` in `index.css`): a document ID in this system is
permanent, assigned once, never reused, carried across every version. So identifiers are set in
gold on a recessed neutral plate â€” stamped into the surface rather than printed on it. It is the
only place gold appears as type, which is what keeps it reading as a mark of record. Used on
document-ID previews in the schema builder, the department prefix chip, and the departments list.

**Two false starts before this, both rejected by the user and both worth remembering:** a
near-black dark theme ("too dark" â€” they meant *moderate*, not dark) and a mid-depth twilight slate
("still too dark"). The lesson is in memory now: on this project, wait for the reference image
before touching the palette. Colour direction here comes from images the user supplies, never from
adjectives.

### Storage screen â€” reports first, changes behind a warning

User's complaint was exact: storage was connected to R2 and verified, yet `/storage-setup` opened
on an empty "connect a new backend" form. Rebuilt `StorageConnectionForm` around three states:

- **Connected (default):** backend name, Connected/error pill, last tested, storage used, quota.
  It reports; it does not invite you to reconnect something you already have.
- **Warned:** clicking "Change storage backend" does not open the form. It shows what changing
  actually costs â€” existing files are *not* migrated and become unreachable from this org; document
  records, IDs and version history survive because they live in the database; and nothing changes
  until the new connection passes its test. Then "I understand â€” change it" / "Keep current
  storage". The warning is specific because "are you sure?" tells nobody anything.
- **Editing:** the original picker and form, with a banner naming what is being replaced and a
  Cancel that returns to the connected view.

**New endpoint `POST /storage/config/test`** to make the connected view useful: re-runs the full
write â†’ read-back â†’ delete round trip against the *already saved* credentials, so health can be
checked without re-entering secrets (PRD Â§11 wants storage-connection health surfaced to the Super
Admin). Credentials are decrypted inside that function only and never returned. Unlike the save
path â€” which deliberately writes nothing on failure, so a bad attempt can't destroy a good config â€”
this one *does* record `status = error`, because the credentials are unchanged either way and a
backend that has gone unreachable is precisely what the button exists to surface. Audit-logged.

**Verified in the browser against the real R2 bucket:** connected view renders correctly, "Test
connection" passed end to end and updated Last tested to the live timestamp, the warning panel
appears before any form, and "Keep current storage" returns cleanly. This wrote one genuine
`config_change` audit event to the real "Abate" org â€” a real use of the feature, left in place
rather than deleted, since it is an accurate record of a test that actually ran.

### A recurring bug class, fixed at the root a second time

`inputClass` carried `w-full`, so every `${inputClass} w-52` silently lost â€” equal-specificity
utilities are resolved by stylesheet order, not source order. It surfaced as the schema builder's
field-type select going full width and pushing each row onto three lines. Split into `inputBase`
(no width) + `inputClass = w-full + inputBase`, and repointed all ten width-overriding call sites.
This is the *same* trap that hit `primaryButtonClass` earlier today; both now carry a comment at
the definition saying why appending a width doesn't work.

Verified: `tsc`, `eslint` and `vite build` clean; backend `tsc`/`eslint` clean. Dev server restarted
twice â€” a `tailwind.config.js` change is not picked up by HMR and leaves the running server
compiling against the old token set (it threw "`bg-surface-inset` class does not exist" until
restarted). Worth remembering: change the Tailwind config, restart the dev server.


## 2026-07-23 â€” Visual system rebuilt from a second reference (emerald on white, dark rail)

User supplied a mockup of *this app's own department screen* â€” far more directive than a palette
swatch, because it settles layout, type and colour together. Rebuilt against it.

**What actually makes that reference read as premium**, and what the previous three attempts got
wrong: it is not the colours. It is (1) a near-black green rail anchoring a light workspace â€” a
light UI with no anchor looks washed out however carefully the surfaces are tuned, which is the
real cause of "too much white"; (2) one action colour used sparingly â€” active tab rule, checkboxes,
selected-row edge, a single primary button per screen; and (3) type running a full step larger than
typical, which is what "make it big and smooth" was asking for.

**Tokens** (`tailwind.config.js`): rail `#0A211D` / raised `#16352F`; primary emerald `#0F6B52`
(hover `#0B5340`, tint `#E7F4EE`); canvas `#F7F8F7`, cards white, nested rows `#F3F4F3`, hairline
`#E4E7E5`; text `#0F172A` / `#4B5563` / `#6B7280`. Plus four **categorical** tints (teal, green,
orange, indigo) used only to tint document-type and template icons so a long list stays scannable â€”
they encode no state and must never be read as one.

**Type**: swapped IBM Plex Sans â†’ **Inter** (taller x-height, rounder, holds up at larger sizes) and
IBM Plex Mono â†’ **JetBrains Mono** for identifiers. Scale moved up throughout: body 15px, inputs
15px in a ~44px field, page titles 30px, section titles 20px, form labels 13.5px `font-medium` in
full ink rather than grey. The wizard was the specific complaint and got the most of this.

**Screens reworked to match the reference's construction:**
- **Rail** â€” dark green, 72 wide, active item a raised tile with a 3px emerald edge, org name and
  Super Admin chip at the top, user card at the bottom. Background decoration deleted entirely: on
  this system it added nothing and had been a source of two earlier defects.
- **Department page** â€” tabs with an emerald underline at 15px semibold; the `ACC` prefix chip and
  `ACC-INV-2026-00001` ID preview as `.plate` (mono, emerald, tinted); document-type list as white
  rows with a tinted icon tile, a 3px emerald edge when selected, and a chevron.
- **Schema builder** â€” roomier field rows on white with clear hairlines, 15px inputs, 16px
  checkboxes, larger hints, and full-width "Add field" / "Add document type" rows.
- **Wizard** â€” template tiles rebuilt in the same language as the document-type list (white card,
  tinted icon tile, emerald edge + check when selected, lift on hover). Grey-on-white tiles had
  read as disabled placeholders rather than choices.

**A layout bug fixed along the way:** the subfolder-depth input had collapsed to about 70px, since a
bare number input sizes to its content and `max-w-xs` alone can't stretch it â€” needs an explicit
width.

Verified in the browser across dashboard, department Overview, department Document types, the
wizard's template step and selection state. `tsc`, `eslint`, `vite build` clean; backend untouched
by this pass.

**Note for the next design change:** this is the fourth palette attempt in one day. The three that
failed were all inferred from adjectives ("premium", "moderate", "not too bright"); the two that
worked came from images the user supplied. Recorded in memory â€” ask for the reference first.


## 2026-07-23 â€” Module 1.3 completed: invite by email (the piece deferred since departments didn't exist)

`ORG-2`/`ORG-3`'s missing half. Now that departments and roles are real, an invitation finally has
something to point at.

**Where the routes live, and why:** invitation management is mounted under
`/departments/:departmentId/invitations`, not under `/organizations`. That is what lets every route
gate on `app.requirePermission("members.invite")` â€” the Module 2.5 engine resolves the department
straight from the route params, so a Department Admin can invite to their own department without
being a Super Admin, and a Staff member cannot. The only org-level addition is
`GET /organizations/current/invitations`, a read-only roll-up for the user directory.

**The flow:** invite (email + role) â†’ token emailed â†’ recipient opens `/invitations/:token` â†’
preview â†’ accept. Plus resend (rotates the token and restarts the clock, so an older link in an
inbox stops working â€” same rule as password reset) and revoke.

**Decisions worth recording:**
- **An existing account must sign in to accept.** Holding the link proves control of the *inbox*,
  not of the account that already owns that address. The accept page sends them to
  `/login?next=/invitations/:token` and back again; login only honours a `next` that starts with
  `/`, so a crafted link can't bounce anyone off-site.
- **A brand-new account is created already email-verified.** Receiving the token at that address is
  exactly the proof that verification exists to establish â€” asking again would be theatre. They are
  signed in immediately on accept rather than being bounced to a login screen.
- **Invitation lifetime is a fixed 7 days, deliberately not env-configurable.** An open invitation
  is a standing grant of access to an organization's documents, so its lifetime is a security
  property rather than a deployment preference.
- **An invite is blocked only by an existing membership in that department** â€” not by the email
  already having an account. Data Model Â§2.3: inviting an existing address creates a *membership*,
  never a second account.
- Expiry is recorded when someone tries to use a stale token (`status = expired`), so the directory
  can show "expired" without every read doing date maths.
- If you are signed in as someone else when you open an invite for a new address, the accept page
  now says so â€” accepting swaps the session, and doing that silently would be a nasty surprise.

**Tested â€” 24 assertions against the running API, all passing**, then cleaned up: create; duplicate
pending blocked (409); inviting an existing member blocked (409); role from another department
refused (404, matching the department module rather than inventing a new shape); department and
org-wide listing; preview returns org/department/role and whether the address already has an
account; garbage token 404s; accept without name or password refused; short password refused;
accept creates the account, marks the invitation used, creates the membership with the invited
role, and returns a session; the token is single-use afterwards (409); revoke works and revoking
twice 409s; a revoked token is refused (410); an expired token is refused (410) and the row is
marked expired; and **a Staff member without `members.invite` is refused (403)** â€” the first
real-world exercise of the permission engine gating a route other than the department module's own.

**Browser:** the department Members tab now carries an invite form (email + role) with a pending
list offering resend and revoke; the user directory shows outstanding invitations org-wide; and
Onboarding's step 3 is no longer a placeholder â€” it links into a department's Members tab, or
explains that invitations need a department first when none exists. The accept page was verified by
creating an invitation row directly and opening its link â€” **deliberately without sending mail to a
real inbox.**

**Flagged for the user:** the API test run did send invitation emails through Brevo to
`@example.test` addresses, which will bounce. Harmless once, but repeated bouncing hurts sender
reputation, so future invite tests should either stub the mailer or use an address on a domain we
control. Worth adding a `MAIL_DISABLED=true` style env switch for test runs before this is
exercised again.


## 2026-07-23 â€” Module 4 (Folders) + the department workspace, permission-driven

User's brief: department people should land *in their department* â€” files and folders â€” not on the
org overview; the current department shown in a corner with a dropdown when they belong to several;
and the UI shaped by permissions, so a role without upload simply has no upload button. Reference
mockup supplied.

### Landing

`"/"` now decides by who you are: a Super Admin gets the organization overview (it is their job),
everyone else is redirected into their department workspace. This is Feature Spec Â§4 verbatim â€”
"on login the user lands directly in their department's documents, not a generic dashboard" â€” and
putting the decision at the route means every entry path (sign-in, refresh, a bookmarked link)
behaves the same. Someone with no department at all gets a plain explanation rather than an empty
dashboard.

### Folders (backend)

`folder` module: list (tree), create, rename, move, delete, breadcrumb path, all audit-logged and
all gated through the Module 2.5 engine via `requirePermission` â€” `folders.create`, `folders.rename`,
`folders.move`, `folders.delete`, and `documents.view` just to read the tree.

Rules implemented, with the reasoning:
- **Depth is checked at creation *and* on move**, and on move it is checked against the deepest
  *descendant*, not the folder being dragged: dropping a three-level branch one level down can push
  its leaves past the limit even though the folder itself is shallow.
- **Lowering a department's limit never orphans existing folders** (FLD-2) â€” the limit is read at
  creation time only. Tested explicitly.
- **A folder cannot move into itself or its own subtree**, which would detach the branch from the
  root and make it unreachable.
- **Confidentiality flows down and cannot be downgraded**: a child of a confidential folder is
  created confidential, and moving a branch into a confidential one marks the whole subtree.
- **Delete is a real delete** (the data model gives `folder` no soft-delete column), so it is
  refused unless the folder is empty of both subfolders and documents. Documents have their own
  trash (Module 11); a folder delete must never take documents with it.
- **The tree is filtered at the query layer**: confidential folders the caller isn't named on are
  removed, *and so are their descendants* â€” otherwise a visible subfolder would betray the
  existence of the hidden parent it hangs from.

`GET /departments/:id/my-permissions?folderId=` is what makes the permission-driven UI possible: it
returns the caller's resolved permission map for that department, re-resolved per folder so a
folder override that restricts further is reflected in the toolbar you actually see.

### A real bug in the permission engine, found by building on it

The engine resolved a confidential folder's named list from the **nearest** confidential ancestor.
That was fine while nothing set `is_confidential` on children â€” but folder creation now propagates
the flag downward (as the data model requires), which makes the nearest confidential ancestor of a
child *the child itself*, and a child carries no member rows. Result: a legitimate member of the
outer vault was locked out of everything inside it.

Fixed in both places that ask the question â€” `resolveEffectivePermissions` and
`confidentialFolderIdsToExclude` â€” which now consider **every** confidential folder in the chain.
Both had to change together: if the list and the resolver disagree, a folder is either listed and
then refused on open, or hidden from someone who genuinely has access. `npm run check:permissions`
still passes 24/24 after the change, and the folder suite covers the case that caught it.

### The workspace (frontend)

`WorkspaceShell` + `DepartmentWorkspacePage`, built from the supplied mockup:
- **Dark rail** with the organization, the **current department** as a card showing its ID prefix,
  and a dropdown to switch â€” rendered as a plain label rather than a control when the person
  belongs to only one department, since a menu that always leads back to where you are is noise.
- **Folder tree** with expand/collapse, a lock marker on confidential folders, and a `+` that only
  exists if you may create folders.
- **Main panel**: breadcrumb, folder title, counts, a table of subfolders with per-row New
  subfolder / Rename / Delete â€” each rendered only if the corresponding permission is held.
- **Toolbar**: the "Add {vocabulary} document" button appears only with `documents.upload`, and the
  search field's placeholder differs when the role has no `search.search`. This is the brief's
  central rule: a role without a permission gets **no control**, not a disabled one.

**Honest about the gap:** documents, upload and search are Modules 6â€“7, so the document controls
are visibly inactive and the quick views (Recent, Uploaded by me, Shared with me/by me, Trash) are
rendered inert with a "with documents" marker. They are shown because they are part of the
workspace's shape; they are inert because pretending otherwise would break the moment anyone
clicked. The panel says so in one line rather than leaving people to discover it.

### Verified

- `npm run check:folders` â€” **23 assertions, all passing**, against a real database with a
  throwaway department: depth at creation and on move, the lowered-limit case, cycle prevention,
  duplicate names per parent, confidentiality inheritance, the non-member and Super-Admin
  exclusions, a named member seeing the whole confidential subtree, delete guards, and
  `my-permissions` reflecting and withholding correctly.
- `npm run check:permissions` â€” 24/24 still green after the engine fix.
- Browser: created a folder, nested a subfolder, navigated by breadcrumb and tree, and deleted
  both â€” confirmed against the network log (POST 201, DELETE 200, list refetched). The test
  folders were removed afterwards; the real Accounts department is back to zero folders.

**One UI change worth keeping:** row actions were revealed on hover, which hides them from keyboard
and touch users entirely. They are always visible now.

**Not built yet, and deliberately so:** `FolderPermission` overrides (break inheritance on a
folder) have engine support and a table but no API or UI â€” that is the remaining half of Module 4.
Confidential-folder *management* (creating one, editing its named list, the dual-control recovery)
is Module 10; the engine and the folder module already enforce its rules, but nothing creates one
through the app yet.


## 2026-07-23 â€” Super Admin is no longer a department member, and two navigation dead-ends fixed

Three defects reported after the workspace shipped, verified fixed against both of the user's real
accounts (`rpa@abateas.com`, Super Admin; `ajuzzz1234@gmail.com`, Department Admin in Accounts + HR).

### 1 & 2 â€” Navigation dead-ends

The organization chrome (`AppShell`) showed the *Super Admin's* nav to everyone, so a department
admin who opened Department settings landed in a shell built for someone else: an Overview link
that led to a blank screen, and no way back to their own workspace.

- `AppShell` now builds its nav from who is viewing. A Super Admin gets Overview + Departments; a
  department admin gets a single "Back to Â«departmentÂ»" and nothing else. The breadcrumb follows
  the same rule â€” "Files" for a department admin, "Departments" for a Super Admin.
- **The blank screen was `navigate()` called during render** in the landing redirect: React bails
  out of that render and nothing is returned. Moved into an effect.
- The Super Admin had no route *into* a department's files at all. Departments now lists **Open
  files** alongside **Settings** per row, and the workspace rail gained "All departments".

### 3 â€” A Super Admin is not automatically part of a department

User's rule, and it overrides the specification:

> a super admin is just a user in a department which he is a member of. If he is not a member he
> can't go inside â€” it's safer. But he can add members and roles in any department by going to
> settings, where he has all permissions.

This contradicts **Feature Spec Â§2A.1** ("Super Admin â€¦ can act in any department regardless of its
role matrix") and **Â§3 Step 4** ("the creator is auto-assigned as the first Department Admin"). The
user was explicit, and the reasoning is sound â€” an owner should be able to *grant* access without
silently *having* it, so that reading a department's files always leaves a membership behind as the
record of who could see what. Implemented as instructed; **`docs/DMS_Feature_and_Flow_Specification.md`
Â§2A.1 and Â§3 Step 4 should be amended to match**, since the docs currently say the opposite and the
docs are meant to govern.

What changed:
- **`createDepartment` no longer creates a membership for its creator.** A new department can now
  start with zero members; the at-least-one-Department-Admin guardrail is enforced on *roles*, and
  on members only once members exist.
- **The engine's Super Admin bypass is narrowed.** With no membership, a Super Admin resolves to
  administrative keys only â€” `members.*`, `configuration.*`, `audit.view_audit`, `audit.export_audit`
  â€” and nothing from documents, folders, sharing or search. With a membership, they read through
  their role like anyone else, plus those administrative keys. `audit.view_confidential_audit` is
  excluded throughout: the confidential exclusion (Â§11.2) is unchanged and remains the one boundary
  a Super Admin never crosses.
- **Folder overrides can't strip the administrative keys.** An override tightens what a *role* may
  do with content in a folder; it has no business removing an owner's department-level rights, so
  those are re-applied after the intersection.
- **Department settings are reachable without read access** â€” `getDepartment` now accepts either
  `documents.view` *or* `members.change_role`, so an administrator who cannot read the files can
  still open settings to add members and roles.
- **The workspace explains the boundary rather than erroring.** A Super Admin who opens a
  department's files without a membership gets a plain screen: what they can do (configure it,
  manage who belongs), what they can't (read it), and buttons to settings or the department list.

**Existing data:** the two auto-created memberships (`rpa@abateas.com` as Department Admin in
Accounts and Human Resources) were removed, since they were created by exactly the behaviour being
rejected. `ajuzzz1234@gmail.com`'s two memberships were left untouched. If the Super Admin wants
file access to a department, adding themselves from the Members tab is now a deliberate, recorded act.

**Checks:** `npm run check:permissions` extended to **30 assertions**, all passing â€” including a
non-member Super Admin getting administrative keys only, being unable to read documents, folder
overrides not stripping their administrative keys, and a Super Admin *with* a membership reading
through their role without gaining what the role lacks. `npm run check:folders` still 23/23.
`tsc`/`eslint`/`vite build` clean on both sides.

**Verified in the browser, both accounts:** the department admin lands in their workspace, opens
Department settings, sees "Back to Accounts" as the only nav and a disabled name field ("Only the
Super Admin can rename a department"), and returns. The Super Admin lands on Overview, reaches both
departments, opens Settings for a department they don't belong to, and gets the "You're not a member
of Accounts" screen â€” with a way onward â€” when opening its files.


## 2026-07-23 â€” Native dropdowns replaced with a proper listbox

User: "there is a lot of dropdown in the UI, all seem bad design â€” we need a premium design."

The cause is structural, not cosmetic. A native `<select>` can be styled as a box, but its **popup
is drawn by the operating system**: system font, system spacing, system-blue highlight. So every
choice in the interface arrived looking like it belonged to a different product. No amount of
CSS on the trigger fixes it â€” the menu has to be ours.

**New `components/Select.tsx`** â€” an accessible listbox that matches the rest of the system:

- Trigger built from the same geometry as the inputs (44px tall, 15px type, emerald focus ring),
  with a chevron that flips when open.
- Menu in a **portal**, because these sit inside tables and cards with `overflow-hidden` that would
  otherwise clip it. It flips above the trigger when there isn't room below, and closes on scroll
  rather than chasing the trigger around the page.
- Selected option in emerald with a check; keyboard-highlighted option on the muted surface.
- Options can carry a **hint line** â€” used to show what each field type does while you're choosing
  it ("Fixed choices Â· filters by multi-select") and to mark which roles can administer the
  department. That is something a native select cannot express at all.
- Full keyboard support: Enter/Space/ArrowDown to open, arrows and Home/End to move, Enter to
  select, Escape to close, Tab to dismiss, and type-ahead â€” the one native behaviour worth keeping.
  Proper `combobox`/`listbox`/`option` roles with `aria-selected`.

Replaced all five native selects: the schema builder's field type, the wizard's member-role picker,
and the department's three role pickers (member role, invite role, add-existing-person).

### A real defect found while testing this

Adding someone to a department fired **on the dropdown's change event** â€” pick a role, and the
person is added immediately, with no confirming action. A stray change event during this session
added the Super Admin to Accounts as Staff without anyone intending it (removed afterwards; the
department is back to one member).

Granting access to a department's documents should never be a side effect of moving a cursor. The
flow is now two steps: choose a role, then press **Add**, which stays disabled until a role is
chosen. The same pattern already applied to invitations, which have always required pressing "Send
invitation".

Verified in the browser as the Super Admin: the role dropdown opens with the styled menu, the
selected role is marked, the hint line shows on administrator roles, and the "Add someone" row now
shows a disabled Add button beside the picker. `tsc`, `eslint`, `vite build` clean.


## 2026-07-24 — Module 5: Documents, identity & versioning (backend)

The first module where real documents get identity, metadata and history. `DOC-1` through `DOC-6`.
Backend only, as the roadmap specifies — the visible UI folds into Module 6 (Upload) and Module 8
(Viewer), which are the things that create and display what this module models.

### The Module 5 / Module 6 boundary, drawn on purpose

The tension in Module 5 is that a document can't exist without a file, but *storing* a file is
Module 6's job (Upload) on top of Module 3's storage abstraction. Rather than blur the two, the
seam is: **this module never touches file bytes.** It records that a version exists at an opaque
`storageRef` handed to it. So `createDocument`/`addVersion` take already-stored file info as a
parameter; Module 6 will call `storage.put()` and then call them. That keeps the document model
storage-agnostic (a CLAUDE.md hard rule — swapping backends is a driver swap, not a change here)
and made the whole module testable now with a stand-in `storageRef`, no storage round-trip needed.

What that means for HTTP endpoints: the operations needing **no new bytes** are live now —
`GET /documents/:id`, `GET /documents/lookup?ref=`, `GET /documents?folderId=`,
`POST /documents/:id/versions/:vid/restore` (restore reuses the stored file, so it needs no upload),
and `PATCH /documents/:id/metadata`. The two that ingest a file — first upload and upload-new-
version — are deliberately Module 6.

### Identity over location (the ID and its generator)

`lib/document-ref.ts` mints `DEPT-TYPE-YYYY-NNNNN` (e.g. `ZZD-CON-2026-00001`) from
`document_ref_sequence`, keyed per org/department/type/year. Two decisions worth recording:
- **The number is reserved inside the same `$transaction` as the document create.** If the create
  rolls back, the sequence never advanced — no gaps. Verified explicitly: seven failed creates in a
  row left `lastNumber` at 2, matching the two documents that actually succeeded.
- **Year is the upload year** (`new Date().getFullYear()`) — the spec says "received automatically
  at upload", and there is no document-date concept at the identity layer.
- Uniqueness has three guards: the per-(org,dept,type,year) sequence, the dept `idPrefix` +
  type `idCode` being unique per department (Module 2), and the `@@unique([organizationId,
  document_ref])` backstop. The ID is immutable and shared across every version — `addVersion`,
  `restoreVersion` and `editMetadata` all leave `document_ref` untouched, asserted in the checks.

### Versioning that never overwrites (DOC-4/DOC-5)

- `addVersion` adds a new `version` row (number = max+1), points `current_version_id` at it, and the
  prior version drops into history. Metadata and ID carry over unchanged. Optional change-note
  becomes the version label.
- `restoreVersion` copies a chosen earlier version **forward** as a new current version, reusing its
  `storage_ref` (the same stored object — nothing is re-uploaded), labelled `Restored from vN`.
  Intervening versions are never deleted, so the chain only grows (1,2,3 after restoring v1 over v2).
  Restoring the already-current version is refused, as is a version id from another document.
- Both are gated by `documents.upload_version`, distinct from first-time `documents.upload`.

### Field values and the title (DOC-6)

`validateFieldValues` checks submitted values against the type's `field_def` set: required fields
present, dropdown values on-list, numbers numeric, dates parseable, and no unknown or duplicated
field. The **title** is derived from the type's `is_title` field's value (`titleValue`), which is
what lists and search show instead of a filename. `editMetadata` re-runs the same validation and
re-derives the title; it changes metadata only, never the ID.

### Access is identity-based, and doesn't leak

Document-scoped routes don't use the `requirePermission` preHandler (the caller has an ID, not a
folder path). Instead the service loads the document and resolves effective permissions **for the
document's own folder**, so a folder override or a confidential boundary is honoured. Rules:
- No `documents.view` → `document_not_found` (404), never `forbidden` — a confidential document is
  invisible entirely, so a distinct error would confirm it exists. `lookupByRef` returns the same
  404 for an unknown ID and for an ID the caller may not see.
- Can view but lacks the specific action (restore/edit) → a real `403`, since existence is no
  longer a secret from them.
- `createDocument` returns the created document **without** re-checking `documents.view`: the route
  enforces `documents.upload`, and a role can hold upload without view (no dependency links them), so
  re-gating the read would wrongly hide what was just made. Uses a no-permission-check raw load.

### Verified — `npm run check:documents`, 40 assertions, all passing

New script `backend/scripts/check-documents.ts` (kept, same pattern as the permission/folder
suites; port to a test runner when one is chosen). Runs against a real database with a throwaway
department, a Contract type carrying one field of every kind, three actors (a Staff uploader, a
department Viewer, and a non-member stranger) and a confidential vault — all deleted afterwards.
Coverage: the ID format and per-document increment; every field-validation failure; no partial
documents and no burned sequence numbers after failed creates; new-version-not-overwrite and
current-version tracking; restore copying forward with the chain intact; exact-ID lookup; metadata
edit updating the title but never the ID; and the identity-based gating — a viewer refused restore
(403) and edit (403), a non-member refused read and lookup (404), a named confidential member able
to read while a department viewer, an ID-lookup, and even the Super Admin are all excluded from the
confidential document. Backend `tsc` and `eslint` clean. **Test data cleaned up** — verified the
real "Abate" org is back to zero `ZZ` departments, zero `zz-doc-` users, and no stray membership on
`ada@example.com`.

**Not done, and deliberately:** no frontend this module (folds into Module 6/7 per the roadmap); no
file-ingesting HTTP endpoints (Module 6); document soft-delete/trash is Module 11 (`Document.status`
and `deletedAt` exist in the schema but nothing writes `in_trash` yet); `Version.ocrText`/`ocrStatus`
default to `pending`/null and stay that way until Module 6's OCR pipeline populates them.

**Next:** Module 6 (Upload & capture) — the endpoint that stores a file and calls `createDocument`/
`addVersion`, bulk upload, duplicate→new-version, and OCR. First, a quick Module 3 confirmation pass
(`put`/`get`/`delete` complete, no direct SDK imports in feature code), since Upload is the first
real consumer of the storage layer.


## 2026-07-24 — Module 6: Upload & capture — backend + OCR worker (frontend still to come)

The first module that moves real bytes. `UPL-1` through `UPL-7`, plus the Module 3 confirmation
pass it depended on. Backend and OCR pipeline are done and verified; the upload **UI** is the
remaining half, deliberately left for its own browser-verified pass.

### Module 3 confirmed, and given a runtime seam

Verified `put`/`get`/`delete`/`testConnection` are complete on both drivers, and a grep confirmed
**no feature code imports an S3 SDK or `node:fs`** — only the two driver files do. What was missing
for real uploads was a *runtime* accessor: added `getActiveStorageDriver(org)` (loads the config,
decrypts credentials in the one place that's allowed to, returns a driver) and
`recordStorageUsage(org, delta)` to the storage service. Every byte in and out of the app goes
through these — Upload and the OCR worker never see a bucket or a path. Module 3 flipped to done.

### Two spec ambiguities, both resolved without guessing

- **Duplicate detection (UPL-4)** needs to know when a file already exists. Added a `checksum`
  (SHA-256 hex) column to `version` — **Data Model §4.5 updated first, then the migration**
  (`20260724052444_version_checksum`), the same doc-governs-first order used for the department
  `rules` column. Duplicate detection is scoped to the department the upload lands in and only
  offers matches the uploader can actually see (no existence leak). A restore copies the source
  checksum forward, since it's the same file.
- **"Never block" (UPL-5)** conflicts with Module 5's strict required-field enforcement. Resolved
  with **no new document state**: `createDocument` gained an `allowIncomplete` flag (upload passes
  it) that skips *only* the required-presence check — types, options, unknown/duplicate fields are
  still validated. The **needs-details queue is a derived query** (`listNeedsDetails`): active
  documents whose type marks a field required but which have no value for it. Fill the fields and
  the document simply drops out of the queue. This keeps `document` free of an "incomplete" status
  the schema never modelled.

### The upload path

`upload.service.ts` orchestrates: resolve format (PDF/PNG/JPEG/DOCX/XLSX, by MIME then extension —
Office files often arrive as `application/octet-stream`, so the extension is a legitimate
fallback), reject over-size (120MB, a margin above the 100MB target — UPL-7) and empty files, hash
the bytes, handle duplicates, **store through the driver**, then create the document (or a version).
Decisions worth recording:
- **Store-then-persist with orphan cleanup.** The object is written to storage first; if the
  document/version DB write then fails, the stored object is deleted and the usage increment
  reverted, so a failed upload never leaves an unreferenced file behind.
- **Duplicate flow is a 409, not a silent choice.** With no `onDuplicate`, a checksum match returns
  `409 duplicate_detected` carrying the matching documents; the client re-submits with
  `new_version` (→ `addVersion` on that document, which independently re-checks
  `documents.upload_version`), `keep_both` (→ a new document), or `skip`.
- **Bulk upload is client-side.** Each file is one independent call to the single endpoint — so one
  file's missing metadata never holds up the batch (UPL-3/UPL-5) — and the shared-fields bar is the
  frontend applying common values to each request. No separate bulk endpoint earns its keep.
- **The canonical MIME is stored**, not whatever the client sent, so the viewer and the OCR worker
  see one value per format.

Endpoints (multipart): `POST /departments/:id/folders/:fid/documents/upload`,
`POST /documents/:id/versions/upload`, and `GET /departments/:id/documents/needs-details`. Multipart
is parsed with the async part iterator so text fields may appear in any order relative to the file;
`@fastify/multipart` is registered with a hard `fileSize` limit, so an over-size file trips a clean
413 rather than being partially read.

### OCR pipeline (UPL-6)

`lib/queue.ts` is a BullMQ `ocr` queue over Redis; `enqueueOcr` is **best-effort** — a Redis outage
is logged and swallowed, leaving the version `pending` and the document fully searchable by
metadata. `src/worker/ocr.worker.ts` is a **separate process** (`npm run worker`): it pulls a job,
reads the file through the storage abstraction, extracts text (Tesseract via `tesseract.js` for
images; embedded text via `pdf-parse` for PDFs, bounded to `OCR_MAX_PAGES` so an oversized scan
can't stall the queue; nothing for Office files), and writes `ocrText`/`ocrStatus`. Any failure is
caught and recorded as `failed` and **not re-thrown** — OCR failure is a terminal degraded state,
not a retryable infra error, so heavy work isn't re-run. Office files are marked `done` at upload
(no enqueue) since there's nothing to OCR.

A note on this dev box: `tesseract.js` fetches its WASM core and language data from a CDN on first
use, and this machine's DNS has been flaky (documented earlier) — image OCR may therefore land as
`failed` here until the assets are cached/pointed at local files. That's the graceful-degradation
path working as designed, not a defect; the PDF path (`pdf-parse` + `pdfjs-dist` + `@napi-rs/canvas`)
runs fully offline.

### Also done: MAIL_DISABLED

Closed the housekeeping item flagged on 2026-07-23: `MAIL_DISABLED=true` now suppresses all outbound
mail (checked in `sendMail` before the Brevo path), so test runs don't bounce real sends. Added to
env + `.env.example`.

### Verified

- Backend `tsc` and `eslint` clean.
- `npm run check:upload` — **17 assertions, all passing**, against the **real R2 bucket**: a stored
  file reads back byte-identical; checksum recorded; duplicate refused pending a choice; skip stores
  nothing; add-as-new-version adds to the original without changing its ID; keep-both makes a
  separate document; an upload missing required fields still saves and surfaces in needs-details
  (naming the missing fields) then clears once completed; unsupported format and over-size both
  refused; a PDF is left `pending` for the worker. **Every stored object is deleted and the org's
  `usedBytes` reverted in a `finally` block** — confirmed afterwards: zero `ZZ` departments, zero
  test documents, Abate storage `usedBytes` back to 0.
- OCR worker booted against Redis (`worker ready`), and a throwaway live test drove the **full
  chain** — upload → enqueue → worker consumes → `storage.get` → extract → DB `ocrStatus=done` —
  then cleaned itself up.

### Environment housekeeping done along the way

Found **~20 stale dev-server/vite processes** accumulated across sessions (the recurring
"stray dev server" problem noted in the log) holding the Prisma query-engine DLL, which blocked
`prisma generate` with an EPERM rename. Stopped them all; regenerate then succeeded. A single fresh
`npm run dev` / `npm run dev:frontend` can be started when needed. Also: 1 pre-existing high-severity
advisory (`find-my-way`, Fastify's own router, an HTTP/2 DoS) surfaced in `npm audit` — **not** from
this module's installs; left for the NFR/deploy pass since fixing it means bumping Fastify.

### Not done, deliberately

The **frontend upload UI** — upload button + drag-and-drop, the per-document-type metadata form,
the bulk shared-fields bar, the duplicate-resolution dialog, and the needs-details view — wired into
the workspace's currently-inert document table and upload button. It's the remaining half of Module
6 and wants a real browser pass, so it's its own next step rather than rushed in unseen.

**Next:** the Module 6 frontend, then Module 7 (Search) — the `tsvector` index now has real
`ocrText` and `FieldValue` content to index.


## 2026-07-24 — Module 6 frontend: the upload experience

Built the UI half of Upload on top of the finished backend, in the established emerald/dark-rail
design language, and browser-verified it against the real app.

**New pieces:**
- `lib/documents.ts` — the documents/upload API client. Multipart uploads can't go through
  `apiRequest` (which forces `application/json`); they need FormData with a browser-set boundary, so
  `multipartPost` carries its own auth header + refresh-once-on-401. The duplicate `409` carries its
  matched documents in the error `details`, read back by `duplicatesFromError`.
- `components/upload/MetadataFields.tsx` — the generated metadata form. One `field_def` drives the
  input control here just as it drives the filter and the search index; dropdowns use the portal
  `Select`, dates/numbers/text use the matching input. Required fields are *marked, not gated* —
  faithful to UPL-5's never-block rule.
- `components/upload/UploadPanel.tsx` — the upload modal: drag-and-drop + browse, one document type
  per batch, a shared metadata form applied to every file (the shared-fields bar), a per-file title
  so each document gets its own name, sequential per-file progress, and inline duplicate resolution
  (add-as-new-version / keep both / skip) when the server returns `duplicate_detected`. Unsupported
  extensions are flagged client-side before anything uploads.
- `components/upload/NeedsDetailsPanel.tsx` — the needs-details queue: lists documents saved
  incomplete, and completes each one's metadata inline with the same generated form (which removes
  it from the queue).

**Workspace wiring (`DepartmentWorkspacePage`):** the document table is real now — folders first,
then documents (ID on the engraved `.plate` with copy-to-clipboard, title, type, size, and a
per-document "New version"). The upload button works and the whole content panel is a drop target
(with a "Drop to add to «folder»" overlay). A "needs details (N)" pill appears when the department
has incomplete documents. Uploading is gated on being inside a folder (documents always live in
one), so the department root shows "Open a folder to add accounts" rather than an upload with
nowhere to land. The old "documents arrive later" placeholder is gone; a slim honest note remains
that search and the viewer are still to come.

**Verified:** `tsc -b`, `eslint`, and `vite build` all clean.

**Browser-verified against the real app** (logged in as a Department Admin in the Accounts dept, via
the restored session): the workspace root (upload hint + real document counts), the folder view
(vocabulary-aware "Add accounts" button, breadcrumb, documents empty state), the upload modal
(header, drop zone with accepted formats + 120MB, disabled Upload until a file is added), and the
portal `Select` of document types (Invoice/Receipt/Purchase Order/Statement, each with its ID code
and the emerald check on the selected one) all render correctly. No test data was created — the app
was left exactly as found.

**One thing not exercised live, and why:** an actual file-*bytes* upload. The browser-automation
tool only uploads files the user has explicitly shared with the session, so it rejected a scratchpad
test file. The byte path itself is already covered by the backend `check:upload` (17/17 against real
R2) and the live OCR chain; what remains unverified purely in the browser is the multipart POST +
duplicate-dialog + needs-details round trip, which is typechecked. Worth a quick confirm run once a
test file is shared (or `/add-dir` on a folder of samples).

**Dev servers** were started for the check (backend :4000, frontend :5173) and left running.

**Next:** Module 7 (Search) — the `tsvector` index now has real filenames, `FieldValue`s and
`ocrText` to index, and the workspace search box + quick-views are already sitting inert waiting for
it. Module 8 (the document viewer) is the other natural follow-on.


## 2026-07-24 — Module 6 frontend refinements (from user feedback)

Four changes to the upload UI after the first pass:

1. **Copy button on the assigned document ID after upload.** A file's `done` row in the upload
   panel now shows its minted ID on the engraved `.plate` with a copy button beside it — the ID is
   permanent and immediately useful, so it's copyable the moment it's assigned. (The document list
   already had this on each row; now the upload result matches.)
2. **Upload from the main section / department root, not only inside a folder.** Since every
   document lives in a folder, the `UploadPanel` now carries a **destination-folder selector**
   (defaulting to the current folder, or the first folder at the root). So the "Add {subject}"
   button and drag-and-drop are offered wherever at least one folder exists — including the root —
   rather than showing "open a folder first". The panel handles the no-folders and no-types cases
   with clear empty states instead of a dead form.
3. **The main panel is files-only; folders are navigated from the sidebar.** Removed the subfolder
   table from the content area entirely (it duplicated the sidebar tree). Inside a folder the panel
   lists that folder's documents; at the department root it shows a "choose a folder from the
   sidebar — or add {subject}s / create your first folder" state. The subtitle count reflects this
   ("N documents · M subfolders in the sidebar").
4. **Folder rename/delete moved onto the current folder's header** (a pencil and a trash beside the
   title), since the per-row folder actions went away with the table. Delete navigates back to the
   parent; the backend still refuses a non-empty folder. New-folder creation stays on the header
   button and the sidebar's `+`.

Also fixed a latent token bug surfaced while touching that block: the confidential badge used
`bg-accent-tint`/`text-accent-strong`, but `accent` isn't a defined colour in the emerald palette
(those classes rendered with no background) — switched to the defined `warning` tints.

**Verified:** `tsc -b`, `eslint`, and `vite build` all clean. **Not re-verified in the browser:**
my repeated full-page navigations during testing raced the app's silent session-restore — the
refresh token rotates on every use, so hammering `/auth/refresh` invalidated the session and bounced
to `/login`, and I don't have the account password to sign back in. The changes are compiler-clean
and the earlier pass already confirmed the panel/folder/Select rendering; a quick logged-in look is
worth doing to confirm these four refinements visually. Dev servers left running on :4000/:5173.

**Possibly worth hardening later** (not touched here): `AuthBootstrap` calling `/auth/refresh` on
mount can log a user out if two refreshes race (React StrictMode double-invoke in dev, or rapid
reloads) because the first rotation revokes the token the second one presents. A single-flight guard
or a small rotation grace window would prevent that.


## 2026-07-24 — Four reported bugs fixed (members, roles tab, org switch, folder tree)

1. **A Department Admin couldn't add members, and the Super Admin could add himself.** The "add
   existing person" picker was fed by `/organizations/current/members`, which is Super-Admin-only,
   and the query was `enabled: isSuperAdmin` — so a Department Admin saw an empty list even though
   the backend `addMember` already permits them (it needs `members.invite`). New endpoint
   `GET /departments/:id/addable-members` (service `listAddableMembers`, gated by `members.invite`
   inside the service so a Department Admin can use it): returns org users not already in the
   department, **excluding the Super Admin (org creator)** — so the Super Admin administers but can
   no longer add himself as a member (the user's rule, consistent with the narrowed Super-Admin
   model in the permission engine). The department page now fetches the caller's own permissions
   (`my-permissions`) and shows the invite / add-existing cards only when they hold `members.invite`,
   and the role-change / remove controls only with `members.change_role`. Verified at the service
   level: the Super Admin call excludes the Super Admin; `ajuzzz1234@gmail.com` (Department Admin,
   `members.invite` = true) calls it without a 403.
2. **Department Admins shouldn't see the Roles tab.** Creating roles and editing the permission
   matrix is a Super-Admin concern (a role can't grant itself powers), so the tab is filtered out
   for non-Super-Admins (`visibleTabs`).
3. **Switching organizations hung on "Opening workspace…".** React-Query caches (`["departments"]`
   and friends) carry no org in their key, so after `select-organization` the landing route read the
   *previous* org's department list and navigated into a department that doesn't exist under the new
   token — stuck loading forever; re-picking worked only because the cache had refetched by then.
   Fix: `queryClient.clear()` on org switch, forcing a clean refetch under the new org scope.
4. **The sidebar folder tree collapsed on every folder click.** The `my-permissions` query key
   includes `folderId`, so navigating between folders briefly made `access` undefined, tripping the
   page's loading guard — which unmounted `WorkspaceShell` and reset its local `expanded` tree state.
   Fix: `placeholderData: keepPreviousData` on the `access` (and `documents`) queries, so the shell
   never unmounts mid-navigation and the expanded tree survives. (Department *changes* still reset
   it, correctly, because the `folders` query — keyed on department only — does blank then.)

`tsc`/`eslint` clean on both sides; `vite build` clean. Not browser-verified this pass: an earlier
session was lost to the refresh-rotation race (see previous entry) and I don't have the password to
sign back in — these are compile-clean and, for bug 1, service-level verified.

## 2026-07-24 — Dropdown closed while scrolling its own list (shared Select)

A long dropdown (the schema builder's field-type picker — six options, each with a hint line, so the
menu exceeds its 288px cap and scrolls internally) closed the moment you scrolled inside it, so the
lower options ("Person") were unreachable. Root cause in `components/Select.tsx`: the open menu
registered a capture-phase `scroll` listener on `window` that closed on **any** scroll — including
scroll events originating from the menu's own scrollable `<ul>`. Fix: the scroll handler now ignores
events whose target is inside the listbox (`listRef.current.contains(event.target)`), so an internal
menu scroll keeps it open while a genuine *page* scroll still closes it (the menu is a fixed-position
portal that would otherwise drift from its trigger). One change fixes **every** dropdown, since they
all share this `Select`. Verified in the browser: opened the field-type picker, scrolled within it,
the menu stayed open and revealed "Person". `tsc`/`eslint`/`vite build` clean.


## 2026-07-24 — Module 7: Search & retrieval (backend + frontend)

Documents can now be found by anything they contain. `SRCH-1` through `SRCH-5`.

### The index

A `search_vector tsvector` column on `document`, GIN-indexed — the Data Model's open item 12.1,
settled. **Doc updated first** (§4.3 + open item), then the migration
(`20260724104538_document_search_vector`). It is *derived state*, never authored:
`refreshDocumentSearchVector` (`lib/search-vector.ts`) recomputes it from the document's own
identity/title (weight A), its field values + current filename (B), and current-version OCR text (C).
Wired into every mutation that changes any of those — `createDocument`, `editMetadata`, `addVersion`,
`restoreVersion` — and into the OCR worker once it writes `ocrText`, so search never drifts from
what a document actually is. A one-off backfill refreshed the existing documents.

Column names on this project are Prisma's camelCase (no snake_case mapping), so the raw SQL quotes
`"documentRef"`, `"searchVector"`, `"field_value"."fieldDefId"` etc. verbatim — confirmed against
`information_schema` before writing a line of it.

### The query (`POST /departments/:id/search`, gated by `search.search`)

- **Text** search builds a *prefix* tsquery — each term sanitised to alphanumerics and suffixed
  `:*` — so "inv" matches "invoice" mid-word (search-as-you-type) with no injection surface.
- **Filters** stack as `EXISTS` conditions on `field_value`, one control per `field_type`: contains
  (text/id/person), exact, dropdown `IN`, date range (ISO strings sort chronologically), number
  range (guarded `~ '^-?[0-9.]+$'` before `::numeric`). Composed safely with `Prisma.sql`/`Prisma.join`.
- **Document-type** scope, **quick views** (recent + uploaded-by-me real; shared-with-me and trash
  are honest empties until Modules 9/11), **most-recent-first** default and **relevance** (`ts_rank`)
  when there's a query. POST, not GET, because the filter set is structured.
- **Confidential exclusion at the query layer** (SRCH-5, CLAUDE.md hard rule): reuses
  `confidentialFolderIdsToExclude`, so a searcher not on a vault's named list never sees its
  documents — verified for a plain member and for the Super Admin (who is excluded from confidential
  everywhere).

Results are ranked as ids in raw SQL, then hydrated through the typed client and re-sorted, so the
display query stays readable.

Verified: `npm run check:search` — **21 assertions, all passing** — title/field/OCR/filename/prefix
matches, every filter type, filters stacking with text, quick views, most-recent-first, and the full
confidential/Super-Admin exclusion. `tsc`/`eslint` clean.

### Frontend

The workspace search bar is live (debounced 250ms → search-as-you-type). When a query, a quick view,
or a filter is active, the main panel switches to a **results view** (ID on the plate + copy, title,
type, folder, and an "Open folder" link — the in-browser viewer is Module 8, so results open where
the document lives). A **Filters** button opens a schema-generated `SearchFilterPanel`: a
document-type selector plus a control per filterable field (contains input, dropdown chips, date/
number range) — the same `field_def` metadata that drives the upload form. The rail's quick views
became real for **Recent** and **Uploaded by me** (Shared/Trash stay inert). Navigating into a folder
clears search (a folder click means "show me this folder"). `tsc`/`eslint`/`vite build` clean.

**Not browser-verified this pass:** the only live session I have is the Super Admin, who isn't a
department member and therefore has no `search.search` and never sees the workspace — so search can't
be exercised from that account. Backend is green and the UI compiles; a member login (`ajuzzz1234`)
is needed for the visual pass.

**Next:** Module 8 (the document viewer) — preview + metadata panel + version history/restore, which
is what search results and folder rows should open into.


## 2026-07-24 — Two fixes: adding the Super Admin, and searching by document ID

**1. A Department Admin can now add the Super Admin to a department; the Super Admin still can't add
himself.** The earlier rule excluded the Super Admin from `listAddableMembers` for *everyone*, and
since the Super Admin (org creator) has no membership row he was never a candidate anyway — so no
one could grant him file access. Refined: the candidate set now explicitly includes the Super Admin,
and the exclusion applies only when the *actor* is the Super Admin (no self-service). A Department
Admin can therefore add the owner if genuinely needed; `addMember`'s `assertUsersAreInOrganization`
already treats the org creator as in-org, so the add succeeds. Verified against the real org:
`ajuzzz1234` (Department Admin) sees the Super Admin as addable; the Super Admin sees 0 (himself
excluded).

**2. Searching by a document ID now works.** Postgres tokenises `ACC-INV-2026-00001` into pieces
like `acc-inv`, `2026`, `-00001` (the numeric suffix picks up a stray leading hyphen), so no tsquery
— concatenated or split — reliably matches a pasted ID. Fix: the text condition now also does a
direct `documentRef ILIKE '%query%'` alongside the tsvector match, so a whole ID, an ID prefix
(`ACC-INV`), or just the number (`00001`) all find the document. Also improved the tsquery tokenizer
to split on any non-alphanumeric run (not only whitespace), so hyphenated *text* queries tokenize
cleanly too. `npm run check:search` now **24/24** (added full-ID, ID-prefix, and partial-ID cases).
No frontend change needed — the search box already sends the raw query. Backend `tsc`/`eslint` clean.

## 2026-07-24 — Per-file-type icons in the documents list

The documents list (and search results, and the upload panel's file rows) used one generic document
icon for every row. Added distinct, colour-coded icons by file type so a list is scannable at a
glance: **PDF** (red), **image** (teal), **spreadsheet / XLSX** (green), **Word / DOCX** (indigo),
anything else a neutral document. New `components/FileTypeIcon.tsx` resolves MIME type (falling back
to the filename extension) to an icon + categorical tint; new `FilePdfIcon` / `FileImageIcon` /
`FileSheetIcon` glyphs in `icons.tsx`. Wired into the folder documents table, the search results
table, and the upload panel's file rows. Purely presentational; `tsc`/`eslint`/`vite build` clean.
Not browser-verified — the only live session is the Super Admin, who isn't a department member and
so can't see a documents list; needs the `ajuzzz1234` login for the visual check.

## 2026-07-24 — Every department has a "main" folder; landing drops you into it (upload-ready)

The department landing page couldn't upload — documents need a folder, and a department with no
folders showed "create a folder first", so someone who just wants to drop files in was stuck. Fixed
by giving every department a default folder and landing members inside it:

- **Backend:** `createDepartment` now creates a default **"General"** folder in the same transaction,
  so a new department is immediately uploadable. Backfilled existing departments that had zero
  folders (two empty test departments got one; HR and Accounts already had folders).
- **Frontend:** the department landing (`/w/:departmentId`) now redirects specifically into the
  **"General"** folder (falling back to the first root folder only if "General" was renamed/removed),
  so the "first page" is a real documents view with the upload button, not a "pick a folder from the
  sidebar" prompt. Folders stay optional organisation in the sidebar for anyone who wants subfolders.

**Refined (per follow-up):** landing targets the "General" folder *by name*, and **every** department
now has one — a second backfill added "General" to departments that already had other folders (HR and
Accounts), not only the empty ones. So even a department with many folders lands in "General", a
consistent, predictable home rather than whichever folder sorts first.

Net effect: arrive in a department → land in "General" with files + an "Add {subject}" button, no
folder-setup step. `tsc`/`eslint` clean on both sides; `vite build` clean. Not browser-verified
(Super-Admin-only session, which isn't a department member) — needs the `ajuzzz1234` login.

## 2026-07-24 — Module 8: Document viewer (backend + frontend)

The screen the whole system points at — search results and folder rows now open into it. `VUE-1..5`.

### Backend

- **`getDocument` is now the viewer payload:** the document + its version history *plus* the caller's
  resolved permission map (so the toolbar is permission-driven, VUE-5) *plus* a short activity feed
  (a filtered `AuditEvent` slice — no separate table, VUE-4). Opening it logs a `view`.
- **`GET /documents/:id/activity`** returns the feed on its own, so the viewer can refresh it after an
  action without re-logging a view.
- **`GET /documents/:id/file?versionId=&download=1`** streams a version's bytes: `documents.preview`
  for inline, `documents.download` for an attachment, resolved for the document's own folder. Bytes
  come through the storage abstraction (never a raw path); a download is audit-logged, a preview
  isn't (the open already was). Confidential feeds stay member-only for free — the endpoints all
  require `documents.view`, which for a confidential folder means being on the named list.
- `npm run check:viewer` — **12 assertions green** against **real R2**: permissions in the payload,
  the logged view, the upload event in the feed, preview + download returning the exact stored bytes,
  a download appearing in the feed, a read-only role (view+preview, no download) blocked from
  download (403) but allowed to preview, and a non-member 404 on both detail and file.

### Frontend

`DocumentViewerPage` at `/documents/:id` — a focused two-panel screen (not the workspace shell):
- **Preview** on the left: PDF in an `<iframe>`, images inline. Bytes are fetched as an **authed
  blob → object URL** (revoked on change/unmount), because an `<img>`/`<iframe>` `src` can't carry
  the in-memory Bearer token. Office files show a "download to open" message.
- **Details** on the right: the **document ID monospaced + copyable** as the panel header (it's
  quoted in emails / written on physical files); **metadata** read-only, or **editable in place**
  under `edit_metadata` (reusing the schema-driven `MetadataFields`); **version history** with
  current marked, **restore** on older versions, and **upload-new-version**; and the **activity
  feed** with relative timestamps.
- **Every action is permission-driven** — download, edit, new-version, restore appear only when the
  resolved permissions grant them (a Viewer sees a genuinely read-only screen, VUE-5).
- Wired in: folder document rows (title + "Open") and search results (title + "Open") now navigate
  to the viewer; a per-type `FileTypeIcon` heads the title bar.

`tsc`/`eslint`/`vite build` clean on both sides; the running backend hot-reloaded the two new routes
(401 unauth = registered). **Not browser-verified** — the only live session is the Super Admin, who
isn't a department member and so can't open a document; needs the `ajuzzz1234` login.

**A note on view-logging:** opening the viewer logs one `view`; after an edit/restore/version the
viewer refetches `getDocument`, which logs another view. Slight feed noise, acceptable for R1 — a
dedicated "load once, update from action returns" path could trim it later, and `getDocumentActivity`
already exists to support that if wanted.

**Next:** Module 9 (Sharing) — the viewer toolbar already reserves the space, and it lights up the
inert "Shared with me / by me" quick views. Or close out Module 4's `FolderPermission` overrides first.

## 2026-07-24 — Fix: "Back" from the viewer now returns to where you opened the file

Opening a document from Recent / Uploaded-by-me / a search, then pressing Back, dropped you in the
**document's own folder** (which for a search/quick-view hit could be anywhere) and lost the search
view. Two causes, both fixed:

1. **The viewer's Back was a hard link to `doc.folderId`.** Now it steps back in history
   (`navigate(-1)`), returning to wherever the document was opened from; it only falls back to the
   document's folder when the viewer was reached directly (no in-app history — e.g. a pasted link,
   detected via `location.key === "default"`).
2. **The search state was component memory, lost when the workspace unmounted.** Moved the search /
   quick-view / filter state into the **URL query string** (`?q=` / `?view=` / `?type=` / `?filters=`)
   in `DepartmentWorkspacePage`. So Back re-lands on the workspace URL *with* those params, the
   workspace remounts and reads them straight back, and the exact Recent/search/filter view is
   restored. A bonus: searches are now shareable/bookmarkable. A plain folder click still exits
   search (its URL carries no query).

`tsc`/`eslint`/`vite build` clean. Not browser-verified (Super-Admin-only session can't open a
document) — but the flow is deterministic: Back → previous URL (with its query) → workspace reads it.

**Follow-up fix (same day):** the URL move broke document-type selection in the filter panel. The
type Select fired *two* URL updates in one handler (set type, then clear filters), and
`setSearchParams` doesn't chain synchronous calls — the second, built from stale params, overwrote
the first and dropped the type, so it never stuck. Collapsed to a single update: `setFilterTypeId`
now sets type and clears filters atomically, and the panel's type Select / "Clear all" each make one
`setSearchParams` call. `tsc`/`eslint`/`vite build` clean.

## 2026-07-25 — Module 9: Sharing (backend + frontend)

The first module where a document deliberately reaches *outside* its home department. SHR-1 through
SHR-6, by reference throughout.

### The access model — a second door, kept separate

The permission engine (`effective-permissions.ts`) decides access through the department/folder/role
chain. A share is a different kind of access — by reference, to a specific document, for someone the
chain doesn't already admit — so it lives in its own resolver, `backend/src/lib/share-access.ts`,
beside the engine rather than inside it. `document.service`'s `resolveDocumentPermissions` consults
them **in order**: the role chain first, and a share only as a fallback for someone it denies. A
share confers a strict read-only floor — view, preview, version history, and download only where the
share allows it — never edit / delete / new-version / re-share. The home department keeps everything
else (Feature Spec §7.2). This was a surgical change to the well-tested document module: one new
helper, `loadDocumentForActor` routed through it, and `getDocument` returning the merged map so a
recipient sees a genuinely read-only toolbar. Both existing check suites (`check:documents` 40/40,
`check:viewer` 12/12) still pass, so the fallback didn't disturb the chain path.

**One deliberate rule written into that resolver: a share can never pierce a confidential folder.**
The fallback is skipped entirely when the document's folder is confidential — the named list is its
only door (§11), so sharing a confidential document internally reaches only people who could already
reach it. A test asserts exactly this ("a share can't pierce a confidential folder").

### The sharing module

`backend/src/modules/sharing/` — service + routes across four mount points (document-scoped create/
list, user-scoped inbox/outbox/control, department-scoped cross-dept consent, and public `/links`).

- **Internal user share** — active at once. Reaching a person who isn't a member of the document's
  home department pierces the tenant's internal boundary, so it additionally requires
  `sharing.cross_department_share`.
- **Department share** — to the home department, active; to another department, `pending` until the
  receiving side consents (SHR-3). Consent is gated at the route by `sharing.cross_department_share`
  on the *receiving* department.
- **External secure link** (SHR-4) — the widest exposure surface, doubly gated (SHR-5): the
  external-share permission **and** the department's `defaultSharing.externalLinksEnabled` rule
  (Module 2.6). Expiry is mandatory — a permanent link can never be created (defaults to the
  department's `linkExpiryDays` if the sharer doesn't set one). Only the **hash** of the token is
  stored (`linkToken`); the raw token lives in the URL, matching every other single-use token in the
  system, so a DB leak doesn't expose live links. Every open is logged and bumps `openedCount`.
- **Least privilege** — you can't grant `download` without holding it yourself; you can't share what
  you can't see (a document you may not view returns `document_not_found`, never a 403, so sharing
  can't probe for a confidential doc's existence); you can't share with yourself.
- Revoke / downgrade / extend (SHR-6) without recreating; only the sharer controls their own shares
  (the department-scoped admin-oversight view is a later, R2 feature).

**A bug I caught while writing it:** the external-link `link_access` audit event first tried to use
the share id as `actorUserId`, which is a required FK to `user` — it would have failed the constraint
and, worse, I'd initially swallowed the error, so SHR-4's "access is logged" would have silently
never logged. Fixed to attribute the open to the link's **creator** (accountable for where the link
went), with the description making clear it was an anonymous open. No schema change, and the event
now always exists.

**Flagged, not silently resolved:** the `Share` schema models `targetType = user | department |
external_link` — there is no **role** target, though the PRD mentions sharing to a role. Built to the
schema and deferred role-sharing; it becomes a new `targetType`, not a rewrite, if a role FK is ever
added.

`npm run check:sharing` — a new `backend/scripts/check-sharing.ts` with **34 assertions, all
passing** against the real DB + real R2 (link file serving included), covering every path above plus
"revoked share removes access at once", "an expired share grants no access / shows as expired", the
cross-dept accept *and* refuse paths, and the confidential external-link block. Cleans up all its
throwaway data afterward.

### Frontend

- **`ShareDialog`** wired into the viewer toolbar (a Share button, shown only with `sharing.share`).
  Internal and external zones are separated by a divider; the **external zone is absent entirely**
  where not permitted (never shown-but-disabled — Feature Spec §7.1). Person/Department toggle,
  view-vs-download, optional expiry, a generated external link with a copy field, and a live "current
  access" list with per-share permission change + revoke.
- **`SharesPage`** (`/shares`) — Shared-with-me (source department, sharer, permission badge, expiry
  countdown) and Shared-by-me (opened count, revoke), as two tabs driven by the URL.
- **`ExternalLinkPage`** (`/l/:token`) — the public landing for an account-less recipient: opens the
  link (recording the access), previews PDF/image inline, and offers download only when the link
  grants it.
- The workspace rail's "Shared with me / Shared by me" (previously inert) and a new org-sidebar
  "Shares" item now link to `/shares`.

`tsc -b`, `eslint`, and `vite build` all clean on the frontend; backend `tsc`/`eslint` clean.

**Not browser-verified** — same limitation as Modules 6/7/8: a Super Admin isn't a department
member, so the share dialog and shared views need the `ajuzzz1234` member login to exercise live.
The backend is green end-to-end; what's unverified-in-browser is only the UI wiring, which is
typechecked.

**Next:** Module 10 (Confidential folders) — mostly the management/named-list UI and the dual-control
recovery flow, since the engine and search already special-case confidential folders. Or Module 4's
remaining `FolderPermission` overrides.

## 2026-07-25 — Sharing: nine fixes from a real walkthrough (behaviour + UX)

User did a hands-on pass over Module 9 and found nine issues. Grouped and fixed.

**1 & 3 — the sharing model was wrong.** Sharing was to *whole departments* with a cross-department
permission gate on reaching people outside your own department. The intended model: a user shares
with **any individual person in the whole organization**, in any department, with just
`sharing.share`. Cross-department reach is by *named person*, never a whole department.
- Backend: `createShare` user-target no longer requires `sharing.cross_department_share` to reach
  someone outside the document's home department — holding `sharing.share` is enough. (The
  department-wide target and its two-sided consent stay in the backend, just unused by the UI now.)
- New `GET /organizations/current/users` — a minimal id/name/email directory any member can read
  (the full member directory is Super-Admin-only), backing the recipient picker.
- Frontend `ShareDialog` recipient is now an **org-wide person picker**; the Person/Department
  toggle is gone.

**3 — a view-only share leaked far too much.** A recipient given *view* could see download, version
history, the activity log, "share", and "new version". A share is additive and read-only by design,
but two things were wrong: the share access floor granted `documents.version_history`, and the
viewer rendered the version-history and activity sections **unconditionally**. Fixed both: the share
floor is now view + preview (+ download only if the share grants it), and the viewer gates version
history *and* activity on `documents.version_history`. A view-only recipient now sees the document
ID, its metadata, and the preview — a Download button appears only when the share allows it, nothing
more.

**2 — Shared views were a separate page.** They now render as **workspace quick views** ("Shared
with me" / "Shared by me"), in the same main-panel list as Recent / Uploaded-by-me, drawing from the
sharing API and spanning every department (a share is inherently cross-department). Extracted a
reusable `SharesList` component used by both the workspace quick views and the org-level `SharesPage`
(kept for the Super Admin, who has no workspace). Department admins get the views too.

**5 & 6 — organization switch + sign-out.** Consolidated the account controls into one
`AccountFooter`, docked at the bottom of the rail on **every** page (name, email, org switch,
sign-out). The org switch appears **only there**, and **only when the user belongs to more than one
org** — it's now an inline dropdown that switches in place (via `/auth/select-organization`), not a
trip to a separate page. Sign-out now asks for confirmation first. Removed the old "Switch
organization" nav button and the duplicated per-shell footers.

**7 — role visibility.** `GET /departments/:id/my-permissions` now returns the caller's `roleName`,
and the workspace rail shows "Your role: <role>" under the department (or "Organization owner (no
role here)" for a Super Admin without a membership).

**8 — revoke felt broken.** It worked server-side, but "Shared by me" kept showing revoked rows
(with a "revoked" pill and no button), so it looked like nothing happened. Now revoked shares drop
out of the list immediately (and the dialog row removes itself optimistically), with error surfacing
if the call actually fails.

**4 & 9 — external links.** External-link sharing already existed but the zone vanished whenever the
department's rule disabled external links, so it looked missing (bug 4). Now the zone is shown
whenever the user holds the permission; if the department disables external links it shows a short
"turn this on under the department's Rules tab" note instead of disappearing (create is still
server-gated). The public external-link viewer (bug 9) shows a proper Download button only when the
link grants download — view-only links get preview only. **Known limitation:** a browser's built-in
PDF viewer has its own download/print controls that a view-only link can't suppress without a custom
PDF renderer — noted, not fixed in R1.

Backend `check:sharing` still **34/34** (the scope change didn't touch the tested guarantees);
`check:documents` 40/40 and `check:viewer` 12/12 unaffected. Backend + frontend `tsc`/`eslint`/`vite
build` all clean.

**Follow-up (same day) — "view-only share still showed everything to an admin."** Diagnosed against
the real data: the recipient (`ajuzzz`) is **Department Admin of the document's own department
(Human Resources)**, so he already had full access to that document through his role. A share is
additive — it can only grant, never restrict — so a view-only share to someone who already
administers that department can't downgrade them (they see the same document in full straight from
their workspace). Not a code bug; it's inherent to sharing being additive.

Briefly tried refusing such a share at creation, but the user overruled it: sharing with someone who
already has access **is wanted** — the "Shared with me" entry is a useful pointer that surfaces one
specific file to a colleague who'd otherwise hunt for it among many. So sharing to anyone in the org
is allowed regardless of their existing access; a view-only share simply can't reduce what a
recipient's own role already grants. `check:sharing` stays **35/35** (the assertion now confirms
sharing to an existing-access user is permitted).

## 2026-07-25 — Sharing: recipient can tidy "Shared with me" + expired shares auto-removed

Two follow-on asks.

**Data model first, then schema** (CLAUDE.md order): `docs/DMS_Data_Model.md` §6.1 gains a nullable
`dismissed_at` on `share`, plus a note that expired shares are swept automatically. Then the schema
(`share.dismissedAt DateTime?`) and migration `20260725070508_share_dismissed`.

**Recipient dismiss.** A recipient can now **Remove** a share from their own "Shared with me" without
revoking it — revoking stays the sharer's tool. `dismissShare` sets `dismissedAt`; only the share's
target user can dismiss, and only a `user` share (a department share reaches many, so one person
can't hide it for everyone). Access is deliberately **unchanged** — it's a view tidy, not a decline.
`listSharedWithMe` filters out dismissed rows. New route `POST /shares/:shareId/dismiss`; frontend
"Remove" button on each inbox row.

**Expired shares auto-removed.** `purgeExpiredShares` deletes expired (`status = active`,
`expires_at` in the past) shares, tenant-scoped, called lazily whenever either share list loads — no
cron needed for a self-hosted deployment. Expired shares already grant no access, so nothing is lost
but the clutter; the original share's audit event still stands. (If a scheduled sweep is ever wanted
instead of lazy-on-read, it's a small BullMQ repeatable job — not built yet.)

`check:sharing` now **39/39** (added: fresh share shows in inbox → dismiss removes it → access
unchanged → only the recipient may dismiss → an expired share is gone from the DB after a list
load). Backend + frontend `tsc`/`eslint`/`vite build` clean.

**Env note:** regenerating the Prisma client for the new column required stopping the running backend
dev server (it locks `query_engine-windows.dll.node`); found two duplicate backend dev stacks
running and consolidated to one clean `npm run dev:backend` on :4000 afterwards.

## 2026-07-25 — Module 10: Confidential folders (CNF-1..4) — backend + frontend

The organization's most sensitive material: folders that are *invisible entirely* to non-members,
not merely locked. Much of the enforcement already existed in the permission engine (Module 2.5) and
the query-layer exclusion (Modules 4/7) — this module added the parts that were missing: creating a
vault, managing its named list, and recovering an orphaned one.

**Creation + named list (CNF-1).** `folder.createFolder` gained an `isConfidential` + `memberUserIds`
path. A folder that *begins* a confidential branch seeds the creator as **owner** (un-removable) plus
any named members; an inherited-confidential subfolder carries **no member rows of its own** — the
engine reads the list from the confidential ancestor, so there's one source of truth. New
`backend/src/modules/confidential/` module: list/add/remove members, every call gated by vault
membership (roles grant nothing here). A non-member — including the Super Admin — gets
`folder_not_found`, never `forbidden`, so the module can't be used to probe a vault's existence.
Management from *any* folder in the vault resolves up to the branch root where the list lives.

**Invisibility, Super Admin exclusion, external-link block, propagation (CNF-2/3).** All already in
the engine; this module confirmed coverage and the check script asserts each against the new creation
path (the vault is hidden from a non-member's tree, a role-holder not on the list can't see it, the
Super Admin is excluded, `sharing.external_share` is forced off inside, and subfolders are auto-
confidential with no rows of their own).

**Dual-control recovery (CNF-4)** — the genuinely new hard part. Because the Super Admin is excluded
and roles grant nothing, an orphaned vault (all members gone) can't be reopened by any one person.
New `confidential_recovery` table (Data Model §7.2 written first, then migration). An orphaned vault
is discoverable **only** to a Super Admin / Department Admin — a deliberate, narrow exception to
invisibility, since recovery is otherwise impossible. `initiateRecovery` records the initiator's own
approval; `approveRecovery` requires the *other* authority; completion needs **both** a Super Admin
and a Department Admin, from two distinct people, and grants a nominated user owner access. Every
step is a confidential audit event.

**Frontend.** A "Make this a confidential folder" toggle + named-member picker in the folder-create
form (suppressed under a confidential parent, which is auto-confidential and says so); a "Manage
access" dialog on any confidential folder (add/remove, owner protected); and a "Recovery" dialog for
Super Admins / Department Admins showing orphaned vaults + pending requests with the two-approver
flow. A reusable `PeoplePicker` (chips + org-user dropdown) is shared by creation and recovery.

**Verified.** `npm run check:confidential` — **29 assertions, all passing** against a real DB
(named-list access, inheritance disabled, owner un-removable, Super Admin excluded, propagation, tree
invisibility, external-link block, add/remove, and the full recovery lifecycle incl. "one authority
alone can't complete"). No regressions: `check:folders` 23/23, `check:permissions` 30/30. Backend +
frontend `tsc`/`eslint`/`vite build` all clean. Needed to stop the backend dev server again to run
the migration/generate (Prisma engine lock), restarted clean on :4000 after.

**CNF-5** — the logging half is done (opens/downloads/member changes write confidential audit
events); filtering them to the `view_confidential_audit` role is the audit *viewer*, which is Module
12.

**Not browser-verified** — same Super-Admin-only-session limitation; the `ajuzzz1234` member login is
what's needed to click through creation, the manage dialog, and recovery.

**Next:** Module 11 (Trash & recovery), or Module 4's remaining `FolderPermission` overrides.

## 2026-07-25 — Module 4 finished: folder permission overrides (FLD-3)

The last piece of Folders: breaking inheritance on a folder to **restrict** a role there. The
permission engine already read `folder_permission` rows and intersected them with the role baseline
(restrict-only, Feature Spec §2A.6) — this session added the CRUD that produces them.

**Backend** (`folder.service.ts`): `listFolderPermissions` / `setFolderPermission` /
`clearFolderPermission`, plus routes under `/departments/:id/folders/:fid/permissions`. Key
decisions:
- **Gated at the *department* level**, not folder-scoped: the routes resolve `configuration.edit_rules`
  against the department (a custom `departmentOnlyTarget` extractor), because otherwise a folder's own
  override could restrict the very permission needed to edit that folder's overrides and lock the admin
  out. Managing overrides is department configuration, not folder content.
- **Stored as "all keys true except the restricted ones"** rather than only the allowed subset. This
  is future-proof: a permission later added to the role passes straight through the override (`true`)
  and is inherited, instead of being silently withheld because the override predates it. The engine
  intersects live, so restrict-only holds regardless.
- **Refused on confidential folders** — they're a distinct mode (named list, inheritance disabled), so
  role-based overrides don't apply.
- An empty `restrict` clears the override (back to plain inheritance). Every change is audit-logged as
  a `permission_change`.

**Frontend** (`FolderPermissionsDialog`): a "Folder access" button on any non-confidential folder,
shown to Department Admins. Pick a role, and the checklist shows only what that role actually grants
(you can only take away); unticking withholds it on this folder and everything under it, with a
dependency cascade (restricting a parent unticks its dependents; re-allowing a child re-ticks its
parents). "Reset to inherited" clears the override.

**Verified.** `npm run check:folders` now **31 assertions** (was 23), covering: inherits before any
override → restricts download on the folder → view untouched (restrict-only) → the restriction flows
down to subfolders → the override is reported → clearing restores inheritance → refused on a
confidential folder → needs a role from the folder's department. No migration needed (the
`folder_permission` table already existed), so the running dev server just hot-reloaded. Backend +
frontend `tsc`/`eslint`/`vite build` all clean.

**Module 4 is now fully complete** (FLD-1..4). **Not browser-verified** — the override dialog needs a
Department-Admin (`ajuzzz1234`) session to click through.

**Next:** Module 11 (Trash & recovery).

## 2026-07-25 — Module 11: Trash & recovery (TRSH-1..4) — backend + frontend

Two-stage deletion: delete moves to trash (recoverable), and only a Department-Admin purge truly
destroys anything.

**Schema (Data Model doc first, then migration `..._document_trash`).** Added `deleted_by_user_id`
to `document` (TRSH-2, "who deleted it"). Changed `audit_event.document_id` to **`ON DELETE SET
NULL`** — the crux that lets a purge hard-delete a document while the **append-only audit trail
survives**: the delete/purge events keep their action, actor, timestamp and the doc's ref in
`target_description`, only losing the FK pointer. This respects "no update/delete path for audit" (a
referential SET-NULL on parent delete isn't an app tampering path) while honouring "purge = truly
gone."

**Backend** (added to `document.service.ts`):
- `deleteDocument` (soft, `documents.delete`) → `status=in_trash` + who/when. Trashed docs already
  drop out of search/recent (the search query filters `status='active'`) and the folder listing.
- `listTrash` (`documents.restore`) → each item with deleter, origin folder, and a 30-day countdown;
  confidential folders excluded at the query layer.
- `restoreDocument` (`documents.restore`) → back to `active` in its origin folder, ID/metadata/
  versions intact.
- `purgeDocument` / `emptyTrash` — **Department-Admin only** (`hasDepartmentAdminCapability`), the one
  place data disappears: deletes the version files via the storage abstraction + the version /
  field-value / share / document rows, reverts storage usage. The audit event is logged *before* the
  row is deleted (so its FK is valid) and then SET-NULL'd by the cascade.
- **Retention-lock enforcement path (TRSH-4)** — `isRetentionLocked()` guards purge and restore.
  The lock *source* is R2, so it returns false in R1 (no-op), but every call site already honours it
  — R2 just gives the predicate a body. No R2 automation built.

**Frontend.** A Delete button in the viewer toolbar and per-row in the folder listing
(`documents.delete`, both reversible → no scary confirm); a **Trash** quick view in the workspace
(same main-panel list pattern as the shared views) showing deleter / origin / colour-weighted
countdown, a Restore action, and — for Department Admins — a hard-confirmed **Empty trash** plus
per-item **Delete forever**. Retention-locked rows show a Locked badge and disable their actions.

**Verified.** `npm run check:trash` — **19 assertions, all passing** against real storage: a reader
can't delete → delete moves to trash → leaves the folder listing → trash shows deleter+origin+
countdown → restore returns it to origin (ID/folder intact) → staff can't purge → Dept-Admin purge
truly deletes the document, its versions **and its stored files** → the purge is still in the audit
trail with a *nulled* document link → staff can't empty trash → Dept-Admin empty-trash purges
everything. No regressions: `check:documents` 40/40, `check:viewer` 12/12. Backend + frontend
`tsc`/`eslint`/`vite build` all clean. Stopped the backend dev server for the migration, restarted
clean on :4000.

**Not browser-verified** — needs a member / Dept-Admin (`ajuzzz1234`) session to click through
delete / restore / empty-trash.

**Next:** Module 12 (Audit log viewer & export) — surfacing everything that's been logged since day
one, including the confidential-access and purge events just added.

## 2026-07-25 — Module 12: Audit log viewer & export (AUD-1..5) — backend + frontend

The compliance surface. Everything since Module 1.5 has been *writing* audit events; this makes them
visible and exportable. No schema change — it reads the existing `audit_event` table.

**AUD-1 — audit-of-the-audit-trail.** A grep of every `logAuditEvent` call confirms full coverage:
view, upload, download, edit, delete, restore, share, link_access, config_change, role_change,
member_change, permission_change. Login/register are deliberately unlogged (global-account actions
with no org FK — the Data Model §8 scope decision, and AUD-1's own list omits them). Nothing to
backfill.

**Backend `audit` module.** `GET /departments/:id/audit` with four **combinable** filters — actor,
action, document (free-text `contains` on the description, so it still matches a ref after purge),
and date range — gated by `audit.view_audit`.
- **Confidential segregation (AUD-5):** `is_confidential` events are dropped from the query entirely
  unless the caller holds `audit.view_confidential_audit`. A Super Admin lacks that key, so even they
  never see that a confidential document was touched — the one place they're blind, consistent with
  §11.
- **Export (AUD-4):** `GET .../audit/export` streams RFC-4180 CSV, gated by the **separate**
  `audit.export_audit` at the route — a View-audit-only Auditor is refused before a single record is
  read. Export is the point data leaves the org, so it's a distinct grant (the classic Auditor
  pattern: inspect, never extract).

**AUD-3 — append-only, confirmed.** A codebase grep shows no `auditEvent.update` / `.delete` anywhere
in `src/` (only test-script cleanup); `lib/audit.ts` exposes a create and nothing else. The Module 11
`ON DELETE SET NULL` on `document_id` is referential integrity on purge, not an edit path — the
event's action/actor/time/description are untouched.

**Frontend.** `AuditPage` (`/w/:departmentId/audit`): a filter bar (user / action / document / from /
to), a **colour-weighted** action table (delete=danger, permission/role/member=warning,
share/link=info, everything else muted), a "includes confidential events" badge when the caller may
see them, a per-row confidential lock marker, and a CSV **Export** button shown only with
`export_audit`. Reached from an "Audit log" button in the workspace header for holders of `view_audit`.

**Verified.** `npm run check:audit` — **15 assertions, all passing**: confidential hidden without the
key / shown with it, each of the four filters narrows correctly (incl. a 40-day-old event excluded by
a date filter), export produces a CSV with every row and marks the confidential one, a view-only
auditor can't export, a no-audit role is refused entirely. Backend + frontend `tsc`/`eslint`/`vite
build` all clean. No migration, so the running backend hot-reloaded — still on :4000.

**Not browser-verified** — needs an Auditor / Dept-Admin (`ajuzzz1234`) session to click through.

**All Release 1 functional modules are now complete** (0–12 + the permission engine). What's left is
Module 13 (non-functional hardening: tenant-isolation + access-control test matrices, performance
targets) and Module 14 (deployment: Docker Compose, TLS, backups, CI/CD).

## 2026-07-25 — Workspace toolbar polish (from a screenshot)

User flagged the department toolbar as looking flat — six near-identical buttons in one row (Filters,
need-details, Add documents, New folder, Recovery, Audit log). Reworked into intentional clusters:
- **Needs-details** is now an alert *chip* (rounded-full, coloured icon bubble) rather than a plain
  button, so it reads as a signal, not another action.
- A **hairline divider** separates the search tools (Filters, needs-details) from the action group.
- **New folder** + **Add documents** (primary) stay visible as the common actions.
- The occasional admin utilities **Recovery** and **Audit log** moved behind a single **"More" (⋯)**
  icon button that opens a dropdown with icon-tiles + one-line descriptions (transparent backdrop for
  outside-click). Keeps the row calm and gives future admin actions a home without growing it.
- Added a `MoreIcon` (horizontal ellipsis) to the icon set.

`tsc`/`eslint`/`vite build` clean; picked up live via HMR. Purely presentational — no behaviour or
permission logic changed. Not browser-verified this session (still the Super-Admin-only login limitation) —
the `ajuzzz1234` member session is what's needed to click through the share dialog, the workspace
shared views, role display, org switch, and revoke.


## 2026-07-25 — Module 13: Non-functional hardening (tenant isolation, access control, performance)

Module 13 in full: the two test matrices the PRD marks "verified by test", the performance targets,
and the encryption posture. Three new check scripts (`check:tenant-isolation`, `check:access-matrix`,
`check:performance`) join the nine that already existed. **Five real defects were found and fixed** —
four of them access-control bugs that every per-module script had passed over, which is the argument
for cross-cutting matrices existing at all.

### 1. Static audit — every Prisma query, classified

Wrote a scanner over all of `backend/src` (274 call sites) that extracts each `prisma.<model>.<op>()`
with its balanced argument text and flags any that carries no `organizationId` and isn't on a
globally-scoped model (`user`, the token tables, `organization` itself). 108 came back for manual
classification; every one turned out to be legitimately scoped — either transitively (an update by
`id` after an org-scoped fetch) or by a paired filter (`{ id, departmentId }` where the department was
already permission-checked). **No unscoped query exists.**

The linchpin is `actor.organizationId`, which every service trusts. Traced it to its source: it is a
JWT claim, minted only by `selectOrganization`/`refresh`, both of which call
`assertUserBelongsToOrganization` first (org creator, or an *active* membership). A user cannot assert
an organization they don't belong to, so the value every query filters on is sound.

The raw SQL in `search.service.ts` is fully `Prisma.sql`-parameterised, including the folder-exclusion
`IN` list — no injection surface.

### 2. `npm run check:tenant-isolation` — 69 assertions, all passing

Builds **two complete organizations from scratch** (never the real Abate org), each with its own
department, roles, users, folders, document types and documents, then calls every reachable service
with org B's actor and org A's ids. Documents, folders, departments, roles, members, document types,
search, sharing, audit, confidential vaults, storage refs, plus referential sanity checks that no row
in one org hangs off a parent in another.

Notably asserts that **org B's Super Admin resolves nothing in org A** — ownership is not global.

### 3. `npm run check:access-matrix` — 77 assertions, all passing

The boundary *inside* one organization: 6 principals (viewer, editor, dept admin, other-department
member, org member with no department, super admin) × 4 locations (ordinary folder, override-restricted
folder, confidential vault, second department), each checked for read access and for the specific
actions the role does and doesn't carry.

### 4. Defects found and fixed

**(a) A Department Admin could permanently destroy confidential documents they cannot see.**
`purgeDocument` loaded the document by `{ id, organizationId }` and then checked only Department-Admin
authority — no `documents.view`, no confidential check. So a Dept Admin who was *not* on a vault's
named list could purge a vault document by ID. Worse, `emptyTrash` listed the department's whole trash
with no confidential exclusion (unlike `listTrash`, which has it) and purged the lot: the admin saw N
items on screen and destroyed N+M. Fixed both — `purgeDocument` now resolves permissions for the
document's own folder and reports `document_not_found` to a non-member (never confirming existence),
and `emptyTrash` acts on exactly the set `listTrash` displayed.

**(b) A folder override hid a document on open but not in search.** The engine correctly refused a
restricted folder's document when opened, but `searchDocuments` only ever excluded *confidential*
folders. A user restricted out of a folder still saw its documents' IDs, titles, types and folder names
in search results, hitting the refusal only on click — leaking exactly the metadata the restriction
exists to withhold. Added `unviewableFolderIdsToExclude()` to the engine (confidential set **plus**
folders where an override withholds `documents.view` from the actor's role, applied down the chain as
the resolver does) and switched search, the needs-details queue and the trash listing to it.
`confidentialFolderIdsToExclude` stays as-is — aggregate counts legitimately include confidential
folders (Data Model §8.1) while a *result list* must not.

Deliberately **not** changed: the folder tree still hides only confidential folders. A restricted
folder remains visible and navigable — the restriction is on its contents, and making it vanish would
be inventing policy the docs don't state. Flagged rather than assumed.

**(c) `folderPath` threw a raw Prisma `P2025`** for a folder in another organization, which the global
error handler would surface as a 500. The tenant boundary is a normal outcome; now a clean 404
`folder_not_found`.

**(d) Two authority checks passed across the tenant boundary.** `listPendingForDepartment` (sharing)
and `requireRecoveryAuthority` (confidential) accepted a foreign `departmentId` — a Super Admin's
`isSuperAdmin` claim, which is about their *own* org, stood in as authority over another org's
department. Neither leaked data (the queries beneath are org-filtered, so both returned empty), but an
authority check that passes across tenants is the wrong shape to leave in place. Both now verify the
department belongs to the actor's organization first.

**(e) Image OCR was completely non-functional.** Found by running the OCR worker during the performance
pass: every image job died with `TypeError: Tesseract.recognize is not a function`. tesseract.js ships
as CommonJS, so `await import("tesseract.js")` returns the module *namespace* and the real API sits on
`.default` — the worker was reading `recognize` off the namespace. Because the worker records any
failure as `ocrStatus = failed` and degrades to metadata-only search (UPL-6, working as designed),
this had been failing **silently** rather than loudly. One-line fix
(`const { default: Tesseract } = await import(...)`); verified by synthesising a PNG and running the
same call the worker makes — 0.7s, text returned, where it previously threw immediately. PDF
extraction was unaffected and always worked, which is why the Module 6 sign-off didn't catch it.

### 5. A layering fact worth recording

Two assertions initially "failed" that turned out to be testing the wrong layer: calling
`folders.createFolder` or `searchDocuments` directly as an under-privileged actor succeeds, because
**folder mutations and search are gated in the route preHandler (`app.requirePermission`), not inside
the service**. That is deliberate and load-bearing — `check:folders` builds its entire fixture as a
Super Admin, who holds no `folders.*` key at all. The matrix now asserts against the same predicate the
preHandler consults (the resolved permission map), which tests the real gate instead of demanding the
service duplicate it. Document-scoped operations are the opposite by design: they resolve permission
*inside* the service, because access there is identity-based (the viewer has an ID, not a path).

### 6. `npm run check:performance` — every PRD target met, with headroom

Measured, not asserted-and-hoped (actuals printed with % of budget):

| Target | Budget | Actual |
|---|---|---|
| Search (500-document corpus, worst of 3 runs, 9 query shapes) | < 2 s | **73 ms** (4%) |
| 20-file bulk upload through real R2 | < 2 min | **28.6 s** (24%) |
| OCR text searchable end-to-end after upload | < 5 min | **2.0 s** (1%) |
| Single upload in 3 clicks or fewer | — | UI property; browser pass |

Search shapes covered: unfiltered listing, single-term, search-as-you-type prefix, multi-term, a pasted
document ID, a partial ID (the ILIKE branch), the `lookupByRef` endpoint, a dropdown filter, and a text
query with two stacked filters. The OCR stage reports SKIPPED rather than failing when no worker is
consuming the queue — an idle worker is an environment fact, not a regression.

### 7. Encryption posture (confirmed, not changed)

- **Passwords** — argon2id.
- **All tokens** (refresh, email verification, password reset, invitation, external share link) —
  SHA-256 hashed at rest; the raw value only ever goes to the client.
- **Storage credentials** — AES-256-GCM (authenticated) with a key from `STORAGE_CREDENTIALS_KEY`,
  decrypted only inside the storage service, and confirmed never returned to the client
  (`getStorageStatus` returns backend type, status, quota and usage only).
- **Refresh cookie** — `httpOnly`, `sameSite=lax`, `secure` in production.
- **In transit (TLS)** and **database-at-rest encryption** are deployment concerns — Module 14's
  reverse proxy and Postgres configuration. Nothing in the application blocks them.

### Regression check

All twelve suites green, no regressions from the engine change:
`permissions 30 · folders 31 · documents 40 · search 24 · viewer 12 · sharing 39 · confidential 29 ·
trash 19 · audit 15 · tenant-isolation 69 · access-matrix 77 · performance 11 passed / 1 skipped`.
`tsc` and `eslint` clean.

**Still outstanding for Module 13:** nothing blocking. The browser-verification pass as a department
member (`ajuzzz1234`) remains the one piece of debt carried from Modules 6–12, and it is now the last
thing before Module 14 (deployment).

## 2026-10-17 — Pre-production: budget plan + repo hygiene + first commit

**Budget.** Two estimate docs added under `docs/`: `DMS_Production_Budget_Estimate.md` (provider
comparison — Hetzner dropped after its June 2026 repricing; DigitalOcean vs AWS EC2/Lightsail) and
`DMS_Budget_Plan_s-4vcpu-8gb.md` (the chosen plan: DigitalOcean `s-4vcpu-8gb` with OCR, ≈ $74/month
in the medium-storage scenario incl. 15% contingency). Prices are third-party estimates — confirm on
the providers' pages. Flagged there: Cloudflare's proxy upload cap (100 MB on Free/Pro, to verify)
is below the app's 120 MB `MAX_UPLOAD_BYTES`.

**Credentials out of the tracked tree.** The test-account passwords that lived in `CLAUDE.md` moved
to `CLAUDE.local.md` (gitignored; Claude Code still loads it). `CLAUDE.md` now points there. These
are dev passwords and must all be changed before production regardless.

**`.gitignore` additions:** `*.tsbuildinfo`, `*.traineddata` (the 5 MB `backend/eng.traineddata`
is tesseract.js's runtime download cache — Module 14's worker image must either bake it in or allow
the first-run download), `graphify-out/` (regenerable), `CLAUDE.local.md`.

**First commit.** The repo had no commits at all; everything is now committed on `master`.
`backend/_backfill.mts` (a one-off search-vector backfill with a hard-coded `C:/apps/DMS/.env`
path) left untracked — delete it or move it into `backend/scripts/` if it's still wanted.

## 2026-10-17 — Member browser-verification pass (Modules 4, 6–12) + 6 fixes

Ran the whole app locally (Docker Postgres/Redis, API, OCR worker, Vite) and drove it in Chrome as
the **Department Admin** in the *Ajilan Personal* org (not Abate — kept test data out of the real
org), then as that org's **Super Admin** for the recipient side. This closes the browser debt carried
since Module 6.

**Verified working end to end:**
- **Upload (UPL)** — the multipart byte path, never driven in a browser before. A generated PDF went
  through the real file input → `AJ-DOC-2026-00001`. OCR worker processed it within seconds.
- **Search (SRCH)** — a word that exists *only inside the PDF* ("zephyr") found the document, so
  upload → worker → `search_vector` → search works for real.
- **Viewer (VUE)** — preview, ID plate, details, version history, activity feed; metadata edit;
  new version (same ID, v1 kept); restore = forward copy (v1 → v3, "Restored from v1"), never an
  overwrite.
- **Sharing (SHR)** — external link opens signed-out at `/l/:token`; revoke kills it on the next
  load ("Link unavailable"). Share-by-reference to a user with **no department role** (the Super
  Admin) appears in their *Shared with me* and opens read-only (no Share/Delete/Download/Edit).
- **Trash (TRSH)** — soft delete leaves search; trash shows deleter, origin, 30-day countdown;
  restore returns it.
- **Confidential (CNF)** — create with toggle, Confidential badge, Manage access (owner protected),
  no role-override control on a vault; Super Admin can't browse the department at all.
- **Audit (AUD)** — every action above appears, confidential events flagged, CSV export present.

**Fixed (all re-verified in the browser afterwards; `tsc`/`eslint`/`vite build` clean):**
1. **View-only readers could download PDFs anyway** — Chrome's built-in PDF viewer shows its own
   download/print toolbar regardless of our permission-driven toolbar. Without `documents.download`
   (viewer) or on a view-only external link, the iframe now gets `#toolbar=0&navpanes=0`. A
   deterrent, not a guarantee (previewed bytes are on the client; Firefox's viewer ignores the
   flag) — a canvas-rendered viewer (PDF.js) is the real fix if this matters more.
2. **Audit padded with phantom "view" events** — every edit/restore/new-version re-fetched
   `GET /documents/:id`, which logs a view. The viewer now takes the updated document from the
   action's own response and refreshes only `GET /documents/:id/activity` (non-logging). Preview
   effect re-keyed on ids so a metadata edit no longer re-downloads the file.
3. **Restore from Trash looked like it failed** — the folder list stayed stale (the folder view
   stays mounted under the trash view, so nothing refetched). `TrashList` now invalidates
   `documents`/`search`/`needs-details`/`trash` for the department.
4. **Fresh 7-day link said "Expires in 6 days"** — `expiryLabel` floored; now rounds.
5. **Revoked link still shown with a Copy button** in the share dialog — hidden once its share is
   revoked.
6. **Dashboard storage bar pinned at 100%** whenever anything was stored (1.8 KB looked like "disk
   full"). The dashboard carries no quota (`storage_config.quota_bytes` exists but isn't returned),
   so the bar is removed; label now "1.8 KB stored in total" / tile "Total stored".

**Found, not changed (flagged):**
- Deleting a document gives **no feedback** — one click, no confirm/undo/"moved to trash" notice.
  Recoverable, but users will wonder what happened. Wants a toast-with-undo (no toast infra yet).
- The department-wide **Trash view sits under the current folder's heading** ("General · 0
  documents"), which reads oddly.
- Chrome's PDF toolbar shows the **blob UUID** as the title instead of the filename (cosmetic).
- "External link opened" logged **twice per open in dev only** — React StrictMode runs the page
  effect twice; production runs it once. No code change.
- Frontend bundle > 500 kB minified — code-split before production (Module 14).

**Test data left in Ajilan Personal / Ajilan:** `AJ-DOC-2026-00001` ("Browser pass test
(renamed)", 4 versions, view share to the Super Admin), folder **BP Vault** (confidential) with
`AJ-DOC-2026-00002`. Safe to purge from Trash; their audit rows stay (append-only).

## 2026-10-17 — Module 14: Deployment & operations (+ pre-production hardening)

Everything needed to run Release 1 on the chosen DigitalOcean `s-4vcpu-8gb` droplet. The whole
production stack was **built and run locally** (`docker compose -p dms-smoke`) and exercised end to
end; nothing below is untested except where stated.

**Hardening (backend):**
- **`TRUST_PROXY`** env → Fastify `trustProxy`. Behind Caddy, `request.ip` (written to
  `login_attempt.ip_address`) was going to be the proxy's IP for every user. Verified in the smoke
  run: the recorded IP is the client, not Caddy's container.
- **Rate limiting** (`@fastify/rate-limit`, `lib/rate-limits.ts`), **opt-in per route, no global
  limit** — an office shares one public IP, so a global per-IP cap would throttle 250 signed-in
  users as one. Tiers: `sensitive` 10/min (register, forgot/reset password, resend verification,
  accept invitation), `login` 30/min (login, verify email — per-email lockout AUTH-7 still applies),
  `publicRead` 120/min (invitation preview, external link open/file). 429 body uses the app's usual
  `{ error: "rate_limited", message }`. Verified live (11th forgot-password → 429).
- **Env validation:** `STORAGE_CREDENTIALS_KEY` must decode to exactly 32 bytes; in production
  `JWT_ACCESS_SECRET` must be ≥ 32 chars and not a `change-me` placeholder — the API refuses to start
  otherwise.
- `/health` logs at warn level (polled every 15 s by the healthcheck).
- **Dependencies:** `prisma` moved to `dependencies` (the image runs `migrate deploy`);
  `npm audit fix` (non-breaking) cleared 6 of 9 high advisories, including a multipart-boundary DoS
  in `@fastify/busboy` that sits under the upload endpoint, plus fastify, find-my-way, fast-uri,
  react-router. **Remaining 3 are Prisma-CLI-only** (`deepmerge-ts` via `@prisma/config`), fixed only
  in Prisma 7 (major) — flagged, not taken.

**Containers:**
- `backend/Dockerfile` — one image, three roles: API (default), OCR worker
  (`node dist/worker/ocr.worker.js`), one-shot `migrate` (`prisma migrate deploy`). Multi-stage,
  runtime has prod deps only, runs as `node` (uid 1000), `openssl` for Prisma's engine.
- `frontend/Dockerfile` — builds the SPA with `VITE_API_URL=/api` and ships it inside Caddy.
- `deploy/Caddyfile` — automatic HTTPS, security headers (HSTS, nosniff, SAMEORIGIN, referrer,
  permissions policy, a deliberately narrow CSP so blob: PDF previews keep working), `/api/*` →
  api with the prefix stripped (same origin: no CORS, the `path=/` refresh cookie just works),
  immutable caching for hashed assets, SPA fallback, 130 MB body cap. **`trusted_proxies` defaults
  to none** — trusting private ranges would let any LAN user (NAS/on-prem deployment) forge
  X-Forwarded-For; Cloudflare-proxied sites set Cloudflare's ranges explicitly.
- `docker-compose.prod.yml` (project `dms-prod`, so it can't collide with the dev project `dms`):
  web, api, worker, migrate, postgres, redis (password, AOF), backup, optional `uptime-kuma`
  profile bound to localhost. No published DB/Redis ports, healthchecks, `json-file` log rotation,
  required-variable checks.
- `deploy/backup/` — `pg_dump` custom format on a cron schedule to `./backups`, local pruning,
  optional copy to a separate R2 bucket; `restore.sh`.
- `.dockerignore`, `.gitattributes` (LF for `*.sh`/Caddyfile/Dockerfile/YAML — a CRLF shebang
  breaks inside Linux containers), `.env.production.example`, `.gitignore` now covers
  `.env.production` and `backups/`.

**CI:** `.github/workflows/ci.yml` — lint, backend typecheck, frontend build, `migrate deploy` on a
fresh Postgres, then the two **self-contained** suites (tenant-isolation 69, access-matrix 77 —
both re-run green against a fresh database locally), then builds all three images. The other ten
suites need the real "Abate" org (some its R2) so they stay dev-only — making them self-contained
is a follow-up. **Not run on GitHub yet** — the repo has no remote. No deploy job: deploys are the
runbook's `git checkout <tag> && dc up -d --build` on the server.

**Runbook:** `deploy/README.md` — droplet + firewall, DNS/Cloudflare (DNS-only recommended; the
three things orange-cloud needs), first deploy, **bootstrapping the first organization** (an
`invite_code` row via psql — the default signup mode requires one, and none exists on a fresh DB),
NAS variant (same path in api + worker, writable by uid 1000), update/rollback (backup first;
migrations are forward-only), backup/restore, secret rotation table, monitoring, troubleshooting,
5-minute post-deploy smoke test.

**Verified locally on the production images (smoke run, then torn down):**
- Migrations applied on a fresh DB (7/7); all services healthy.
- Through Caddy: headers present, `Server` stripped, SPA fallback, `/api` proxy, bundle calls
  `/api` (no `localhost:4000`), gzip 507 KB → 147 KB, `caddy fmt` clean.
- Scripted end-to-end (14/14): invite code via psql → register → verify → create org (code is
  single-use) → refresh cookie `Path=/; HttpOnly; SameSite=Lax; Secure` → client IP recorded
  correctly → NAS storage verified writing as uid 1000 → department → PDF upload through Caddy →
  OCR worker in its container → search by a word inside the file → preview bytes → 126 MiB → 413.
- Image OCR: tesseract.js initialised in the worker container and downloaded its language data
  into the writable working directory.
- Backup → sentinel row → restore (api/worker stopped) → counts identical, sentinel gone; cron
  schedule fires with the environment intact.

**Not verified:** the off-server copy to R2 (no backup bucket/keys yet), Let's Encrypt issuance
(needs the real domain), the GitHub Actions run itself. **Not built:** Sentry (Tech Stack §3.10) —
errors go to container logs only.

## 2026-10-17 — Step-by-step production deployment guide

Added `docs/DMS_Deployment_Guide.md` for the user to deploy themselves: every step marked Windows /
Server / Browser with the expected result after each. Covers: pushing to a private GitHub repo +
release tag; DigitalOcean droplet (`s-4vcpu-8gb`), cloud firewall, alerts; server hardening (`deploy`
user, root + password SSH off via `00-hardening.conf` so it wins over cloud-init, swap, unattended
upgrades); Docker; Cloudflare DNS (grey cloud), Brevo domain authentication + API key, two R2 buckets
with separately scoped tokens and a 60-day lifecycle on backups; read-only GitHub deploy key; filling
`.env.production` (secrets generated with `openssl`); build/start with expected `dc ps` states;
first-organization bootstrap (single-use invite code via psql → register → create org → verify →
onboarding storage/department/invites, with the exact UI labels); a 9-point verification table;
uptime monitoring; routine; troubleshooting; final checklist. `deploy/README.md` now points to it.

## 2026-10-17 — End-user guide by persona (Claude Doc) + 3 UI gaps found

Wrote the non-technical user guide as a shareable doc ("Abate DMS — User Guide",
https://claude.ai/code/artifact/1ab6231a-7c23-445e-ac63-efed80775d66), every label checked against
the frontend: how-to-use table, basics + screen tour, getting in, Staff, Managers, Read-only users,
Department Admin, Super Admin, Auditor, Confidential folders, Outside recipients, a default-role ×
feature table, and quick answers. Personas follow the template roles actually shipped (Staff,
manager-type roles, Auditor, Department Admin) — there is no built-in "Viewer"; the guide tells admins
to make one by copying Staff.

**Gaps found while writing it (the guide documents today's behaviour; not fixed):**
1. **Managers can't invite.** Manager-type template roles carry `members.invite`, but the Members tab
   lives under Department settings, shown only with `configuration.edit_metadata_schema` (Dept Admin)
   or to a Super Admin — the permission has no screen.
2. **No folder move in the UI.** `lib/folders.ts` has `moveFolder` (FLD-4 API is built and tested)
   but nothing calls it.
3. **Super Admin without a department role can't reach that department's Audit log or Recovery.**
   Both live in the workspace's ⋯ menu, and the workspace shows "You're not a member" to a
   non-member Super Admin, even though the engine grants them `audit.view_audit` and recovery
   authority. Reachable only by typing `/w/<id>/audit`.

## 2026-10-17 — Fixed gaps 1 & 2: managers can invite; folders can be moved (+ a privilege-escalation fix)

**Gap 1 — managers' `members.invite` had no screen.**
- The left panel now shows **Members** (people icon) to anyone holding `members.invite`,
  `members.change_role` or `members.remove` who can't configure the department; Department Admins
  and the Super Admin still see **Department settings**.
- `DepartmentDetailPage` shows only the tabs the caller can act on: Overview + Rules need
  `configuration.edit_rules` (what the PATCH enforces), Document types any document-type /
  metadata-schema key, Roles stays Super-Admin-only, Members is always visible (read-only when
  nothing is granted). It waits for the caller's permissions before rendering so tabs don't flash.
  The remove button now follows `members.remove` (it was keyed to `members.change_role`).
- **Security fix found on the way — `members.invite` could grant any role.** Invite and
  add-existing-member accepted any role in the department, so a manager could have invited or added
  a Department Admin through the API. New `canGrantRole()` in the permission engine: you may only
  grant a role whose permissions you hold yourself in that department (Super Admin exempt). Enforced
  in `createInvitation`, `addMember` and `changeMemberRole` (`403 role_exceeds_yours`); the UI offers
  only grantable roles and says so.

**Gap 2 — no folder move in the UI (FLD-4).**
- New `MoveFolderDialog` (+ `FolderMoveIcon`), opened from a move button next to rename/delete for
  `folders.move` holders. Destination tree (top level + the caller's visible folders), with invalid
  spots disabled and labelled: current location, the folder itself / its own subfolders, "Too deep"
  (the whole branch's depth against the limit), "Already has a folder with this name". Warns that
  moving into a confidential folder makes it confidential permanently. Refreshes folders and
  re-resolves permissions afterwards.
- **Second gap closed:** the move route only checked `folders.move` on the folder being moved, so the
  API accepted a destination the caller couldn't see — e.g. a confidential vault they aren't named
  on. The route now gates `folders.move` at the destination as well (same engine, same uniform 403,
  so it reveals nothing). Kept in the route, not the service, per the documented layering invariant —
  a first attempt in the service broke `check:folders`, which builds fixtures through the service.

**Tests:** `check:access-matrix` **88** (was 77; +11: manager can't add/invite a Dept Admin, can add
within their own role, can't change roles, Super Admin can grant any role, destination gate refuses an
unseen vault and admits ordinary folders/top level, move there and back). Green: `check:folders` 31,
`check:confidential` 29, `check:permissions` 30, `check:tenant-isolation` 69, `check:documents` 40.
Backend + frontend `tsc`/`eslint` clean. **Not browser-verified** — the dev servers were stopped for
low memory and weren't restarted.

**User guide updated** (it had also been wrong in two places): Department Admins don't see the Roles
tab (Super Admin only — section moved), the Super Admin can't add themselves to a department (a
Department Admin must), the ID prefix *is* editable (affects new documents only); added Managers'
"Move a folder" and "Invite people", and refreshed the who-can-do-what table.

Gap 3 (non-member Super Admin can't reach a department's Audit log / Recovery) is still open.

## 2026-10-30 — PRD v1.2: Edoc rename, auto-delete, daily retention run, Legal Hold, standard filters

Implemented the v1.2 change brief (Changes 1–8). Retention automation was Release 2; this brief
brings a narrow slice of it into R1 on the user's explicit instruction — PRD §8.14 (RET-1..8),
SRCH-6 and the amended TRSH-4 were added to the docs, and CLAUDE.md's build-phase line updated.

**Decisions the user made in this session (2026-10-30):**
1. **No automatic trash purge existed** (the 30-day countdown was display-only). Built one: the
   daily run permanently removes **every** trash item older than 30 days — user-deleted or
   auto-deleted — skipping Legal Holds. Matches Feature Spec "truly gone when the window lapses".
2. **System actor:** `audit_event.actor_user_id` is now nullable with a new `actor_type`
   (user | system); a check constraint ties the two. No fake "System" user account.
3. **Organization time zone:** new `organization.time_zone` (default Asia/Kolkata), editable by the
   Super Admin in Organization settings. Drives the Upload Date filter and the run's "today".
4. **Existing confidential-audit leak fixed:** download / delete / restore / purge / metadata edit /
   new version of confidential documents were logged `is_confidential = false` and showed in the
   ordinary audit view (CNF-5/AUD-5). `logAuditEvent` now derives the flag from the document's folder
   whenever an event names a document. Existing rows untouched (append-only).

**Decisions made here (flagged in the hand-off):** 29 Feb uploads are due on **1 Mar** in common
years (never early); the Upcoming Deletions list **shows held documents, marked**; Super Admin is
refused the new rights (not in its administrative baseline); in a confidential folder, holds *and*
restoring an auto-deleted document are the **Owner's** (on any confidential ancestor); a hold blocks
destruction only (view/edit/new version/restore still work); a folder with an active hold can't be
deleted, and a folder covered by an ancestor's hold can't be moved outside it; a parent-folder hold
also covers confidential subfolders (without revealing them); archived departments are still
processed; hold **reasons** are shown only to people who may manage holds (others see the badge);
the preview count includes confidential documents (a count reveals no contents, and a destructive
confirmation must not under-report); manual purge keeps its existing `delete` audit action, the
automatic purge writes the new `purge` action.

**Schema — migration `20261030054602_retention_legal_hold`** (+ `down.sql` beside it):
`organization.timeZone`; `department.autoDeleteYears` (1–100, null = off); `document.uploadedAt`
(backfilled from the earliest version, immutable via trigger `document_uploaded_at_immutable`),
`trashSource`, `trashReason`, index `(departmentId, status, uploadedAt)`; new `legal_hold` table
(one-target / complete-removal / non-blank-reason checks, one active hold per target, FKs RESTRICT);
`audit_event.actorType` + nullable actor (FK stays RESTRICT); five new `AuditAction` values; the three
retention keys granted to the 5 existing Department-Admin-capable roles. Rollback is partial by
design: enum values can't be dropped, and `down.sql` refuses to run once a system audit row exists.

**Backend:** `lib/calendar.ts` (zone-aware dates, leap rule, next run), `lib/legal-hold.ts` (coverage,
hold index, authority), `lib/audit.ts` (SYSTEM_ACTOR, derived confidentiality), new
`modules/retention` (setting + preview/confirm, upcoming list, holds, `runAutoDelete`,
`runTrashPurge`), `worker/retention.worker.ts` (BullMQ job scheduler at RETENTION_JOB_TIME /
RETENTION_JOB_TIME_ZONE; `--once`). `document.service.ts`: one soft-delete path
(`moveDocumentToTrash`) and one destruction path (`destroyTrashedDocument`) shared by people and
the job, both refusing held documents; restore of an auto-deleted document needs hold authority and
places a "Restored after auto-delete" hold; `createDocument` stamps document + v1 with one instant.
Search: inclusive Upload Date From/To in the org's zone, `invalid_date_range`. Folders: hold state in
the listing, `canManageLegalHold` in my-permissions, delete/move guards. Permissions: new
"Retention" group (manage_auto_delete, manage_legal_hold, view_upcoming_deletions).
Compose: new `retention-worker` service. Env: RETENTION_JOB_TIME, RETENTION_JOB_TIME_ZONE.

**Frontend:** Department settings → **Retention** tab (auto-delete with a red preview-and-confirm
dialog, Upcoming deletions with "Place hold", Legal holds with "Lift"); `LegalHold.tsx` (badge +
reason dialog); viewer hold panel (Delete hidden while held, Upload Date shown); folder header
"Place Legal Hold"/"Lift hold" + badge, rail hold icon, held rows hide Delete; Trash shows reason,
System as deleter, hold badge, "Hold" action, restore gated; filter panel's always-on Upload Date
range with inline validation; audit viewer "System" actor + new action labels; Organization settings
time zone. Product name: page title, emails, env sender default → **Edoc**.

**Tests** — new: `check:retention` 105, `check:legal-hold` 67, `check:filters` 19, `check:rename` 137
(no DB) — fixtures in `scripts/_retention-fixtures.ts` build throwaway orgs and scope every run to them.
Regression, before → after, all green: permissions 30→30, folders 31→31, documents 40→40, upload
17→17, search 24→24, viewer 12→12, sharing 39→39, confidential 29→29, trash 19→19, audit 15→15,
tenant-isolation 69→69, access-matrix 88→88, performance 10 + 2 skipped → same. Lint, both
typechecks and the frontend build clean. `retention:run-once` and the scheduler checked live
(next fire 31 Oct 02:00 IST).

**Browser-verified (Dept Admin, Abate HR):** Retention tab, preview dialog (cancelled — nothing
saved), Upload Date filter + From-after-To message, folder hold dialog's required reason (cancelled),
viewer Upload Date + "Place Legal Hold". Fixed on the way: the confirm button lost its red to
`bg-primary` (same-specificity utilities); a false "No matches" under an invalid date range. Not
clicked through on real data (to avoid permanent audit rows): actually placing/lifting a hold,
saving a period, the trash hold action — all covered by the suites.

**Left unchanged — review later:** internal "DMS" identifiers (repo folder, `docs/DMS_*.md` names,
`dms`/`dms-prod` compose, DB and volume names, `dms-backend`/`dms-web` images, `.dms-test-*` NAS
probe file, `dms:currentOrganizationId` storage key, `C:/apps/DMS/.env` in test scripts, CLAUDE.md's
"# DMS Project" title, historical text in this log and the roadmap). Pre-existing, not fixed:
`text-accent` (rail lock icon) is not a defined colour token; TrashList's "Delete forever" confirm
uses `primaryButtonBase` + `bg-danger`, the same conflict fixed above. Audit immutability is still
enforced in the application, not by DB grants/trigger (test teardown deletes audit rows) — consider
DB-level grants for production.

## 2026-11-04 — Custom date-range picker replaces the browser's calendar in filters

**Why:** the Upload Date filter (and the audit log's From/To) used native `<input type="date">`.
Its popup is drawn by the browser — system font, system blue, different in every browser, one end
of the range at a time — so it read as "old, not premium" next to the rest of the UI. Same problem
`Select` solved for dropdowns.

**New — `frontend/src/components/DateRangePicker.tsx`:** one field with Start → End halves (click
either to edit that end) and a clear ×; popover (portal, flips above/clamps on screen like `Select`)
with a month grid that draws the span as an emerald band, hover preview of the end being chosen,
today dot, faint adjacent-month days, month and year pickers (click the title), optional
**Quick ranges** column (Today, Yesterday, Last 7/30 days, This/Last month, This/Last year — chips
on phones), and a footer with the range summary, day count, Clear and Done. Keyboard: arrows,
Home/End, PageUp/PageDown (Shift = year), Enter picks, Esc closes and refocuses. Week start follows
the browser locale (Monday fallback). Values are unchanged — inclusive `YYYY-MM-DD`, "" for an open
end, either end may stay open — built from local Y/M/D so no zone shift. Picking a start after the
end clears the end; picking an end before the start restarts the range there.
`icons.tsx`: new `ArrowRightIcon`.

**Used in:** filter panel Upload date (with presets; now one column beside Document type), filter
panel date-field filters (`date_range`, no presets — number ranges keep their inputs), Audit log
Date (with presets, spans the old From + To columns).

**Verified in the browser (Dept Admin, Abate HR):** range pick + hover preview → URL
`from/to` updated; reopen shows committed band; month/year views; "Last 30 days" and "Last month"
presets; keyboard pick + Esc; invalid From > To shows the red field and message; audit "Last month"
narrowed to 11 October events. Build, lint, typecheck clean. Not clicked live: a date-type field
filter (no filterable date field on the HR types used) and phone width.

**Noticed, not changed:** `MetadataFields.tsx` (upload / edit metadata) still uses the native date
input. AuditPage builds `from` with `new Date("YYYY-MM-DD")` (UTC midnight), so in IST events from
00:00–05:30 on the From day are excluded — pre-existing; flagged, not fixed.
Vite's watcher missed one rapid edit on Windows and served a stale module ("DateRangePicker is not
defined") until the file was touched — a dev-server quirk, not a code issue.

## 2026-11-07 — Claude Design wireframe prompt
- Added docs/Claude_Design_Wireframe_Prompt.md: a 12-flow prompt (screens, actions, states, permissions) for generating presentation wireframes. No code changes.

## 2026-11-07 — Security audit, step 1 (access control & tenant isolation)
- Added SECURITY_AUDIT.md: code-review of all routes/services, permission engine, auth, sharing, storage, uploads, deps. 4 High, 8 Medium, 10 Low findings; none fixed yet. No code changes. Findings confirmed by code reading only (app/DB not running); reproduction recipes included.

## 2026-11-07 — Security fix H-1: department ↔ folder binding (SECURITY_AUDIT.md)
- **Bug (confirmed live, 17 failing checks before the fix):** routes resolved permission for the department in the URL but services acted on the folder id alone. An Admin of dept A could, under A's URL, list / upload into / rename / move / delete dept B's folders, read B's role matrix, and set or clear overrides on B's roles.
- **Fix:** `lib/effective-permissions.ts` — a folder whose chain belongs to a different department than the one being resolved grants nothing. Defence in depth: `folder.service.ts` (`loadFolder`, `folderPath`, rename/move/delete, list/set/clear overrides), `document.service.ts listFolderDocuments`, `upload.service.ts uploadDocument` now bind the folder to the URL's department (404 `folder_not_found`). Routes pass `departmentId` through.
- **Test:** new `npm run check:department-binding` (HTTP-level via `app.inject`, 29 checks incl. positive controls). Full suite 16/16 green (633 checks), tsc + lint clean.

## 2026-11-07 — Security fix H-2: share & history exposure (SECURITY_AUDIT.md)
- **Bug (confirmed live, 17 failing checks before the fix):** `GET /documents/:id` returned the home folder / department / document-type / field-definition ids to a view-only share recipient, plus every version (uploader e-mails, change notes) and the activity feed to anyone with `documents.view`. Only the UI hid them. `/activity` needed only `documents.view`; `/file?versionId=` served any old version.
- **Fix (`document.service.ts`):** new `loadDocumentAccess` returns the permission map with the document; `shapeDocument(doc, view)` shapes the response to it. Share-only callers get those ids as null. Without `documents.version_history`, callers get the current version only (no uploader or change note) and an empty activity feed. The same shaping applies to the edit / new-version / restore responses. `/activity` now requires `documents.version_history`; an older version's file needs it too (otherwise 404 `version_not_found`).
- **Frontend:** `DocumentDetail` ids are nullable. In the viewer, Back falls back to `/`, field keys fall back to the label, and ShareDialog needs `departmentId`. `NeedsDetailsPanel` skips null field ids.
- **Test:** new `npm run check:share-exposure` (HTTP-level, 42 checks incl. positive controls; fails 17 on the old behaviour). `check:upload` now counts versions in the DB, because its role lacks version history. Full suite 19/19 green (688 checks); tsc + lint clean on both sides.

## 2026-11-07 — Security fix H-3: role-editing escalation (SECURITY_AUDIT.md)
- **Bug (confirmed live, 16 failing checks before the fix):** `createRole` / `copyRole` / `updateRole` / `deleteRole` required only `members.change_role`. A delegated HR manager could give their own role every permission (becoming a Department Admin), create or copy super-roles, and strip, rename or delete roles above them.
- **Fix (`department.service.ts`):** new `assertRoleWithinReach` (built on `canGrantRole`; the Super Admin is exempt) returns 403 `role_exceeds_yours`. It applies to: create (the new map, after dependency closure), copy (the source role), update (both the current and the new map, so nothing above you can be changed and nothing can be raised beyond you), and delete (the role being deleted). An unchanged re-save is allowed, because the roles page PUTs every role. No frontend change; the error message shows on the roles page.
- **Test:** new `npm run check:role-escalation` (HTTP-level, 24 checks with DB verification and positive controls). Full suite 20/20 green (712 checks); tsc + lint clean. M-7 (demoting or removing *members* above you) is still open.

## 2026-11-07 — Security fix M-7: can't act on members above you (SECURITY_AUDIT.md)
- **Bug (confirmed live, 7 failing checks):** `changeMemberRole` / `removeMember` checked only the new role and the last-admin guard. An HR manager with `members.change_role` / `members.remove` demoted and removed Department Admins while another admin remained.
- **Fix (`department.service.ts`):** new `assertMemberWithinReach` (built on `canGrantRole`; the Super Admin is exempt) refuses with 403 `member_above_you` when the target's current role holds anything the actor lacks. Peers and self are still allowed. Org-level enable/disable is Super-Admin-only and unchanged.
- **Test:** new `npm run check:member-hierarchy` (16 checks incl. controls and the last-admin guard). Full suite 21/21 green (728 checks); tsc + lint clean.

## 2026-11-07 — Security fix H-4: external links re-checked on every open (SECURITY_AUDIT.md)
- **Bug (confirmed live, 30 failing checks across 7 scenarios):** `resolveLink` checked only token, status and expiry. Links kept serving the file after the document was trashed, after its folder or an ancestor became confidential, after the sharer was disabled (membership or account) or lost the link permissions, and after the department turned links off. Download links kept downloading after the sharer lost download.
- **Fix (`sharing.service.ts resolveLink`):** on every open and file fetch it re-checks that the document is active, the sharer's account is active, the permission engine still grants the sharer view + share + create_link + external_share for the document's current folder (this covers confidential and lost access), and the department still allows links. A failure gives the uniform `link_unavailable` 404 and is not counted or logged. The link is suspended, not revoked, so reversing the condition restores it. A download link drops to view-only if the sharer lost download.
- **Test:** new `npm run check:link-revalidation` (48 checks; each scenario proves the link works, dies on both endpoints, then works again). Full suite 22/22 green (776 checks); tsc + lint clean. Not done: link password (product decision), L-2.

## 2026-11-07 — Security fix M-1 (part 1): audit trail append-only in the database (SECURITY_AUDIT.md)
- **Bug (confirmed: 11/11 tampering probes succeeded before the fix):** nothing in Postgres stopped UPDATE / DELETE / TRUNCATE of `audit_event`; append-only was a code convention only.
- **Fix:** migration `20261107120000_audit_append_only` (+ `down.sql`) adds triggers that refuse every UPDATE, DELETE and TRUNCATE. Two exceptions: the FK `ON DELETE SET NULL` (an update that changes only `documentId` to NULL), and test cleanup. Cleanup needs both a database-level mark (`dms.audit_purge_allowed`, read from `pg_db_role_setting`; session SET can't fake it) and a per-transaction opt-in. Production is never marked.
- New `npm run db:mark-disposable` (refuses NODE_ENV=production and non-local hosts); dev DB `dms` is marked. All 19 test scripts' cleanup now goes through `scripts/_audit-purge.ts`. CI marks its throwaway DB and runs the new suite. README notes the one-time step.
- **Test:** new `npm run check:audit-immutability` (18 checks; every probe runs in a rolled-back transaction, so it is safe even without the trigger). Full suite 23/23 green (794 checks), no leftover fixtures; tsc + lint clean.
- **Still open (part 2):** run app/worker as a DB role with only INSERT, SELECT on audit_event and no DDL. That's a deployment change (compose, secrets, deploy guide).

## 2026-11-07 — Security fix M-2: sessions follow account / membership state at once (SECURITY_AUDIT.md)
- **Bug (confirmed live, 9 failing checks):** within the 15-min access-token life, a user disabled in the org still opened documents shared with them, their confidential vault and "Shared with me". A disabled account (`user.status`) kept working and kept refreshing (30-day refresh token). A stale `isSuperAdmin` claim was honoured.
- **Fix:** `plugins/authenticate.ts` re-checks on every request that the account is active (401 `account_disabled`) and that the user still owns or actively belongs to the token's org (401 `session_revoked`), and re-derives `isSuperAdmin` from the DB. `auth.service.ts refresh` refuses a disabled account and revokes all its refresh tokens. The frontend's existing 401 → refresh flow handles both codes.
- **Test:** new `npm run check:session-revocation` (HTTP-level, 17 checks incl. re-enable controls). Full suite 24/24 green (811 checks; `check:legal-hold` had one flaky timestamp-window failure, Docker vs host clock, passed 3/3 on rerun; not related). tsc + lint clean.

## 2026-11-07 — Security fix M-3: login lockout can no longer lock out the owner (SECURITY_AUDIT.md)
- **Bug (confirmed live, 4 failing checks):** failures were counted per email, so 5 wrong passwords from any IP locked the account everywhere for 15 minutes, which an attacker could repeat indefinitely.
- **Fix (`auth.service.ts login`):** 5 failures lock the (email, IP) pair only. A per-account counter (`LOGIN_MAX_ATTEMPTS_PER_ACCOUNT`, default 50 per window) handles distributed guessing: once past it, only IPs with a successful login for that account in the last `LOGIN_TRUSTED_IP_DAYS` (30) may try. A success clears only that IP's counter. New env vars are in `env.ts` and both `.env` examples (with defaults, so no deploy change is required).
- **Test:** new `npm run check:login-lockout` (HTTP-level, 9 checks). Residual: an attacker sharing the owner's IP (same office) can still lock that pair; a CAPTCHA or e-mail unlock is a product decision.
- Full suite after M-3: 25/25 green (820 checks); tsc + lint clean.

## 2026-11-07 — Security fix M-4: storage settings can't point the server anywhere (SECURITY_AUDIT.md)
- **Bug (confirmed live, 21 failing checks):** a NAS mount path could be any server directory (saved as "verified"; errors told existing paths from missing). An R2 endpoint could be any URL: the server really contacted localhost, the metadata address and example.com, and reported their answers. NAS keys with `../` wrote outside the mount.
- **Fix:** new `modules/storage/storage.policy.ts`, enforced in `buildDriver` (save, re-test and every live use). NAS paths must resolve inside `STORAGE_NAS_ROOT` (required for NAS in production; unset in dev = any path). R2 must be `https://<account>.r2.cloudflarestorage.com` with no creds, port, path or query, or a host in `STORAGE_R2_ALLOWED_HOSTS`. The NAS driver refuses keys that escape the mount. New env vars are documented in both `.env` examples and the compose NAS comment. Existing dev configs (R2) unaffected.
- **Test:** new `npm run check:storage-targets` (25 checks, no external network after the fix).
- Full suite after M-4: 26/26 green (845 checks); tsc + lint clean.

## 2026-11-07 — Security fix M-5 (part 1): uploads verified by content, concurrency capped (SECURITY_AUDIT.md)
- **Bug (confirmed live, 21 failing checks):** a file was accepted when its declared MIME *or* extension matched, and the bytes were never checked. An HTML page, an executable and an SVG were stored as PDF/PNG (and later served inline as such). Uploads (held whole in memory, up to 120 MB) had no concurrency limit.
- **Fix:** `lib/upload-formats.ts` `detectFormat` / `verifyUploadFormat` (magic bytes; OOXML by ZIP directory, no decompression). Content must be a real accepted format and agree with the claim (JPEG and PNG interchangeable). The stored MIME is the detected one; the new codes are `unrecognised_content` / `content_mismatch`. New `lib/upload-limiter.ts`: a slot per upload taken before the body is read (`MAX_CONCURRENT_UPLOADS` 8, `MAX_CONCURRENT_UPLOADS_PER_USER` 2), 429 `upload_busy` + Retry-After. Applied to both upload routes. The env examples document the knobs.
- **Tests:** new `npm run check:upload-content` (29 checks incl. a slow-streamed upload proving the cap). New `scripts/_fixture-files.ts` (real minimal PDF/PNG/JPEG/DOCX/XLSX); check-upload / viewer / sharing / trash / performance fixtures switched to real files.
- **Still open:** antivirus scanning, true streaming to storage, an OCR worker sandbox (infrastructure / larger refactor).
- Full suite after M-5: 27/27 green (859 checks; check:performance needed its fixture import aliased - a local `pdfBytes` shadowed it); tsc + lint clean.

## 2026-11-07 — Security fix M-6: only a confidential folder's owner manages its list (SECURITY_AUDIT.md)
- **Decision (product owner, 2026-11-07):** owner-only. The docs were silent; now recorded in Feature Spec §11.1 and Data Model §6.
- **Bug (confirmed live):** any member could add anyone in the org to a vault or remove other members.
- **Fix:** `confidential.service.ts` `requireVaultOwner` on add/remove (403 `not_vault_owner` for members; non-members still get 404). `listMembers` returns `canManage`, and the removal audit names the removed user. Frontend `ConfidentialDialogs.tsx` shows Add/Remove only to the owner, with a read-only note for others.
- **Test:** new `npm run check:vault-owner` (13 checks). check:confidential 29/29, tenant-isolation 69/69, access-matrix 88/88, folders 31/31; tsc + lint clean (both sides).

## 2026-11-07 — Security fix M-8: vulnerable dependencies (SECURITY_AUDIT.md)
- `zod` 3.24 → **4.6.7** (backend; a major upgrade, high advisory). No code changes beyond `ZodError.flatten()` → `z.flattenError()` in `app.ts` / `env.ts`. The validation-error response shape is verified unchanged.
- `fast-uri` patched (3.1.9 / 4.2.3) via non-breaking `npm audit fix`.
- `deepmerge-ts` (high) **accepted**: it's only inside the Prisma CLI's config loader (`prisma` → `@prisma/config`), unreachable from requests. The fix needs Prisma 7 (a major migration), to plan separately; add the CI `npm audit` gate with it.
- Note: `npm audit fix --omit=dev` pruned dev deps from node_modules (tsc/eslint broke); restored with `npm install`. The lockfile was not affected.
- Full suite 28/28 green (872 checks); tsc (backend + frontend) + lint clean.

## 2026-11-07 — Documentation: API reference + developer guide
- **New `docs/API_Reference.md`** (~800 lines), written from the route and service code: conventions, error shape, rate limits, the auth/guard chain, an index of all 103 endpoints (guards and permission), per-module request/response/behaviour, and a full error-code catalogue.
- **New `docs/developer/`**, 11 files: README (index, reading order, hard rules) · 01 Architecture · 02 Getting started (setup, full env-var reference, scripts, first-org SQL) · 03 Database schema (every table/column, constraints, triggers, indexes, JSON shapes, search vector, migration history, isolation checklist) · 04 Security & permissions (sessions, catalogue with enforcement map, resolution algorithm, escalation rules, vaults, sharing access, audit status) · 05 Backend modules (every service/lib function, rules, audit actions) · 06 Workflows (sequence/state diagrams) · 07 Frontend · 08 Testing (all 28 suites, anatomy, rules) · 09 Deployment & operations · 10 Conventions, recipes, traps, known gaps.
- Root `README.md` links both. `deploy/README.md` §5 (NAS) now includes the `STORAGE_NAS_ROOT` step required since M-4.
- **Found while documenting (not changed):** `sharing.remove_share`, `search.advanced_search` and `configuration.edit_metadata_schema` are catalogued but never enforced. `clearFolderPermission` writes no audit event. `storage_config.usedBytes` isn't decremented on purge, and `quotaBytes` isn't enforced. `login_attempt` is never pruned. Expired shares are deleted lazily when share lists load. All are recorded in 10_Conventions_and_Extending.md.
- Every relative link and anchor was validated (0 broken).

## 2026-11-07 — Markdown (.md/.markdown) and plain-text (.txt) documents
- **Product decision (owner, 2026-11-07):** accept Markdown and plain text. Markdown is shown **rendered and safe**. Recorded in Scope §(formats), PRD (Upload, Compatibility, R1 table) and Feature Spec §6.4.
- **Backend:** `lib/upload-formats.ts` adds `text/markdown` (md, markdown) and `text/plain` (txt) with `ocr: "text"`. Within the text family the extension decides (`.md` sent as `text/plain` stays Markdown). `isPlainText` requires valid UTF-8, no control bytes, and not an HTML/SVG/XML page; a binary format renamed to a text extension is `content_mismatch` (a note that merely mentions `%PDF-` is still text). `upload.service.ts` stores the text as `ocrText` with `ocrStatus: done` at upload (`ocrFields`/`needsOcr`), so text docs are searchable immediately without the OCR worker; the worker also handles text. File responses (viewer and external link) send `charset=utf-8` for text and `X-Content-Type-Options: nosniff` (`contentTypeHeader`).
- **Frontend:** new `MarkdownView` (react-markdown 10.1.0 + remark-gfm 4.0.1, pinned): `skipHtml`, default URL sanitising, images NOT auto-loaded (shown as links), external links `noopener noreferrer`, styled with app tokens. Lazy-loaded via `LazyMarkdownView` (its own 201 kB chunk). Viewer and external-link page preview Markdown rendered and `.txt` as plain text. Accepted-type lists centralised (`ACCEPTED_UPLOAD_ACCEPT`); Markdown gets an orange file icon.
- **Tests:** `check:upload-content` +28 checks (57 total): 4 accepted variants, text stored at upload, found by search, served as UTF-8 + nosniff, 8 refusals (HTML/SVG pages, invalid UTF-8, control bytes, PNG/PDF/DOCX renamed). A server-side render check of `MarkdownView` confirmed script/iframe/handlers stripped, `javascript:`/`data:` links neutralised, images not loaded, and GFM tables/task lists working.
- **Bug found and fixed:** `check:upload` had silently stopped after 3 of 18 checks since the M-5 fixture rename (a stale `docxBytes` reference threw, and the script had no `catch`, so it still exited 0). Fixed the reference and added a `catch` that records the error as a FAIL; 18/18 again. `check:rename` updated docs wording. Full suite 28/28 green.
- **Not verified in a browser:** the Chrome extension disconnected, so the rendered look still needs a visual check.

## 2026-11-09 — Fix: uploading to a different folder looked like it failed (HR)

**Reported:** in Human Resources, starting an upload from "General" and choosing "main" as the
destination (or the reverse) appeared not to upload.

**Root cause:** the upload actually succeeded — confirmed via the API and in the browser (the file
was filed into the chosen folder with a new document ID). But the dialog only showed the document
ID, and closing it left the user in the folder they started from, so the new file never appeared on
screen and it read as a failure. Backend, permissions and the folder picker were all correct.

**Fix (frontend only):**
- `components/upload/UploadPanel.tsx` — each filed row now says **"Filed in <folder>"**; the panel
  remembers the folder the latest file landed in and passes it to `onClose(filedToFolderId)` from
  every close path (Done/Cancel, ✕, backdrop).
- `pages/DepartmentWorkspacePage.tsx` — on close, if files went to a folder other than the one open,
  navigate to that folder so the new files are visible.

**Verified:** `tsc --noEmit` clean; in the browser, from General → upload into main → row reads
"Filed in main" → Done lands on the main folder with the new document listed.

**Test data left behind:** HR-CON-2026-00005, -00007, -00008 (main) and -00006 (General, `a.pdf`)
were created while reproducing — safe to move to Trash.

## 2026-11-09 — Housekeeping commit + security fixes L-1 and L-9 (SECURITY_AUDIT.md)

- **Commit:** all pending work (PRD v1.2, the 2026-11-07 security fixes, docs, .md/.txt support,
  the upload-destination fix) committed as `e7f4925` on new branch `release1-v1.2-and-security`.
  `backend/_backfill.mts` deliberately left uncommitted (one-off, hard-coded path — audit L-8).
- **L-1 CSV injection:** `audit.service.ts` `csvCell` (now exported) prefixes cells starting with
  `= + - @`, tab or CR with `'` before RFC-4180 quoting, so audit exports open as text in Excel.
- **L-9 JWT algorithm:** `lib/jwt.ts` signs with an explicit `HS256` and verifies with
  `algorithms: ["HS256"]` only; HS512 and `alg: none` tokens are refused. `iss`/`aud` not added.
- **Test:** new DB-free `npm run check:low-hardening` (15/15). `check:audit` 15/15 and
  `check:session-revocation` 17/17 unchanged; tsc + eslint clean.
- `CLAUDE.local.md`: marked the `rpa@abateas.com` login as stale (rejected today).

## 2026-11-11 — Data protection: survive losing Postgres or R2 (plan: Layers 1, 3, 4 started)

**Why:** Postgres is the only map from opaque object keys (`<org>/<uuid>`) to documents; files in R2 are anonymous without it, and the only DB backup sat on the same droplet.

- **Backups (`deploy/backup/`):** `backup.sh` now verifies each dump (`pg_restore --list` + minimum size), can encrypt with `age` (`BACKUP_AGE_RECIPIENT`; `restore.sh` decrypts via `BACKUP_AGE_IDENTITY`), fails the run if no off-site copy was made (`BACKUP_REQUIRE_OFFSITE`, default true in `docker-compose.prod.yml`), and pings a dead-man's-switch (`BACKUP_HEALTHCHECK_URL`, `/fail` on failure). The Dockerfile adds `age`.
- **Self-describing objects:** `StorageDriver.put` takes optional `ObjectMeta` (org, file name, sha256, uploader); the R2 driver stores it as object metadata and sends `ChecksumSHA256` so R2 rejects corrupted uploads; the NAS driver now writes temp → fsync → rename.
- **Manifest + scrub:** new `backend/src/worker/data-guard.ts` (compose service `data-guard`): daily JSONL manifest of every version (storage ref, checksum, file name, document ref/title, folder path) into `./backups`, which `backup.sh` encrypts and ships off-site; plus a sample re-hash of stored files against `Version.checksum` (missing/mismatch → logged, exit 1, `/fail` ping).
- **Purge ordering:** `destroyTrashedDocument` now deletes DB rows first and files second, and logs (not swallows) a failed file delete — a failure leaves an orphan blob, never a row pointing at a deleted file. Legal Hold check unchanged.
- **Verified:** `tsc --noEmit` clean. **Not verified:** DB-backed checks (`check:trash`, `check:retention`, `check:upload`, `check:storage-targets`) could not run — dev Postgres at localhost:5433 was down. The R2 `ChecksumSHA256` header and `age`/healthcheck paths have not been exercised against real R2 or a built container.
- **Still to do (not code):** ~~enable R2 bucket versioning~~ (R2 has no S3 versioning — corrected below) + replication to a second provider; put the off-site backups bucket in a different account; keep the `age` private key and `.env.production` offline; disaster-recovery runbook + monthly restore drill. **Decision needed:** a delayed blob-delete grace period needs a new table (data-model change) — rely on R2 versioning for now?

## 2026-11-11 — Data protection docs + deployment steps

- **New doc `docs/DMS_Data_Protection_and_Restore.md`:**
  - Why the DB and R2 depend on each other, and the 8 protection layers.
  - What each component does, and alert handling.
  - Restore procedures: same-server DB restore, full rebuild on a new server, files from the replica, undoing a purge, last-resort recovery from the manifest, lost secrets.
  - Monthly restore drill, settings reference, known limits.
- **Correction:** Cloudflare R2 has **no S3 bucket versioning** (it has bucket locks, which would block Edoc's own purges). The design is now: every off-site copy is in **Backblaze B2**, a different provider.
  - Encrypted dumps and manifests go to a backups bucket: hidden after 90 days, erased 30 days after hiding.
  - Documents are replicated nightly by host-cron `rclone sync` (R2 read-only token → B2 replica bucket, deletions kept 90 days, `--max-delete 500` tripwire).
  - Both B2 keys are created with the `b2` CLI **without `deleteFiles`**.
- **Deployment Guide:**
  - Part 0 adds B2, Healthchecks.io, a USB stick and two golden rules.
  - The worksheet is extended.
  - 5.3 is rewritten: R2 now holds documents only, with an app token and a read-only replica token.
  - New sections: 5.4 B2 buckets + no-delete keys, 5.5 age key pair, 5.6 Healthchecks.
  - 6.4 gets the new env vars.
  - New 7.0 creates the backups folder (uid 1000). 7.2/7.3 list `data-guard`.
  - New **Part 10:** the replica job, plus go-live checks a–f (manifest/scrub, encrypted off-site backup, no-delete key test, alert test, first restore drill, droplet backups).
  - Monitoring, Routine and Troubleshooting are renumbered to 11/12/13. The routine gains a monthly drill and a yearly rebuild. The checklist is extended.
- **Also updated:**
  - `deploy/README.md` §5 (NAS needs the mount in `data-guard`), §7 (rewritten), §8 (B2 and age keys), §9 and §11.
  - `.env.production.example` (new vars, B2 endpoint).
  - `docs/DMS_Technology_Stack.md` backups row.
  - `docs/developer/01`, `02` and `09`.
- **Code:** the backup image adds `curl`, and the health ping uses it (busybox `wget` may lack HTTPS). The compose comment notes that NAS must also be mounted in `data-guard`.
- **Compliance flag:** the B2 replica keeps permanently deleted documents for up to 90 days. This needs confirming against the retention policy (Data Protection §3.6).
- **Not verified:** none of the deployment steps were run against real B2/R2/Healthchecks. The `b2 key create` capability list (incl. `listAllBucketNames` for S3-API use) and rclone's B2 hide-on-delete behaviour are from the providers' documented behaviour, not tested here. Go-live check 10.6 c/d exists to prove them.

## 2026-11-11 — Regression test of the data-protection changes

- **Backend:** `tsc --noEmit` and eslint are clean.
  - All **28 check suites pass** (0 failures): 1,064 checks in total, including upload 18/18, trash 19/19, retention 105/105, legal-hold 67/67, storage-targets 25/25, tenant-isolation 69/69 and access-matrix 88/88.
  - `check:upload` runs against the real Abate R2 bucket, so R2 accepted the new `ChecksumSHA256` header and object metadata.
- **data-guard** (against dev DB + real R2):
  - The manifest has 29 versions.
  - Scrub: 24/24 and 5/5 files re-hashed and matching. The two orgs with no storage were skipped as designed.
- **Backup image** (built locally, against the dev DB):
  - With `BACKUP_REQUIRE_OFFSITE=true` and no bucket, the run fails as intended.
  - The encrypted dump is written and verified.
  - Restoring into a scratch DB gives identical counts (21 docs / 29 versions / 478 audit / 9 users / 3 protection triggers).
  - Decrypting with the wrong age key is refused.
  - Upload to an unreachable endpoint gives FAILED, exit 1, and a `/fail` ping is attempted.
  - Upload to a local S3 stand-in (`rclone serve s3`) copies the dump and the manifest, both encrypted; the manifest decrypts to 29 lines.
  - The scratch DB was dropped; the dev DB was untouched.
- **Not tested:** real Backblaze B2 (keys and lifecycle), Healthchecks.io, and the host-cron replica script. These are covered by Deployment Guide go-live checks 10.6.

## 2026-11-11 — Image OCR switched off for production (budget: 2 vCPU / 4 GB server)

**Why:** management dropped OCR from Release 1. The budget (Claude Doc *Edoc Production Budget*, ≈ $42/month) sizes the server at `s-2vcpu-4gb`, which can't carry Tesseract.

- **New setting `OCR_IMAGES_ENABLED`** (`config/env.ts`): **off unless "true"/"1"**.
  - `upload.service.ts` `needsOcr(env, format)`: with it off, JPG/PNG versions are stored `ocrStatus=done` with no text and are **never queued**. They stay searchable by name, ID and metadata.
  - PDFs are always queued for embedded-text extraction (light, not Tesseract). This is unchanged. Scanned PDFs were never OCR'd in any case.
  - The OCR worker has a second guard: an image job queued earlier returns no text without loading Tesseract. Its start-up log now reads `(PDF text: on, image OCR: off)`.
- **Production can't turn it on by accident:**
  - `docker-compose.prod.yml` pins `OCR_IMAGES_ENABLED: ${OCR_IMAGES_ENABLED:-false}` in the shared backend block and in `data-guard`.
  - `docker compose config` confirms `"false"` in api, worker, retention-worker, migrate and data-guard, both with the example file and with the line deleted from it.
  - `.env.production.example` / `.env.example` set it to `false`.
  - `.env.production.example` also sets `MAX_CONCURRENT_UPLOADS=4` (~0.5 GB of buffers for a 4 GB server).
- **Docs:**
  - Deployment Guide: droplet size is now `s-2vcpu-4gb` ($24); cost table, expected worker log and the troubleshooting row are updated.
  - `deploy/README.md`: size, troubleshooting, and how to turn image OCR on later (resize first).
  - Developer docs 02/09 updated.
  - `DMS_Budget_Plan_s-4vcpu-8gb.md` is marked superseded; it is kept as the with-OCR costing.
- **Tests:**
  - `check:upload-content` gains 2 permanent checks (59/59). With the switch off, images are `done` and absent from the BullMQ `ocr` queue while PDFs are queued. Run with `OCR_IMAGES_ENABLED=true`, images are pending and queued (also 59/59).
  - Full suite: all 28 suites pass, 1,077 checks, 0 failures. `tsc` and eslint are clean.

## 2026-11-11 — Full verification + docs aligned with the final decisions

**Final decisions everything now follows:**
- **Server:** DigitalOcean `s-2vcpu-4gb`, with image OCR **off** (`OCR_IMAGES_ENABLED=false`) and `MAX_CONCURRENT_UPLOADS=4`.
- **Storage:** documents in R2; every off-site copy in Backblaze B2.
  - Encrypted dumps and manifests: hidden after 90 days, erased 30 days later.
  - File replica: deletions kept 90 days.
  - No-delete keys.
- **Jobs:** data-guard 01:30, backup 02:00, replica 03:30 UTC. Healthchecks.io alerts for each.
- **Budget:** ≈ $42/month (Claude Doc *Edoc Production Budget*).

**Docs fixed to match:**
- `DMS_Scope_and_MVP_Definition.md` and `DMS_Technology_Stack.md`: a dated **production decision note** next to the OCR requirement. The Tech Stack server row is now 2 vCPU / 4 GB.
- `DMS_Production_Budget_Estimate.md`: marked superseded.
- `CLAUDE.md` stack line, root `README.md` worker comment, `DEVELOPMENT_ROADMAP.md` "Next up" (B2, guide, budget, data-protection doc), and developer docs 01/05/06: image OCR described as off unless enabled.
- A repo-wide grep finds no remaining reference to the 8 GB server as current, R2 backups buckets, R2 versioning or the 60-day lifecycle.

**⚠ Flag:** PRD UPL-6 / SRCH-1 and the Scope doc still list OCR of scans as a Release 1 requirement. The feature is built and tested. Production runs with it off by management decision, and that is recorded beside the Scope line. The PRD text itself is unchanged and is the product owner's call.

**Verification run:**
- **Backend:** `tsc` clean, eslint clean. All **28 suites pass: 1,077 checks, 0 failures**, including the `rename` suite that checks the docs' product naming.
- **Frontend:** eslint, typecheck and production build all pass.
- **Data-protection numbers:** code defaults match every doc (times, retention days, bucket and alert names).
- **Production compose:** `docker compose config` resolves `OCR_IMAGES_ENABLED: "false"` in all 5 backend services, even with the line removed from the env file.
- **Production backend image** (built from `backend/Dockerfile`, runs as uid 1000):
  - Contains `dist/worker/data-guard.js`.
  - The OCR worker starts with `(PDF text: on, image OCR: off)`.
  - `data-guard --once` writes the manifest and verifies 29/29 files on real R2. Two orgs with no storage are skipped as designed.
- **Earlier today:** backup and restore round trip with `age` encryption and the off-site upload, verified against a local S3 stand-in.
- **Not verifiable locally:** real Backblaze B2, Healthchecks.io and the host-cron replica job. They are covered by Deployment Guide go-live checks 10.6 a–f.

## 2026-11-12 — Dev server reachable on the local network

- `frontend/vite.config.ts`: `server.host: true`, so Vite listens on every interface (the backend
  already listens on `0.0.0.0`).
- `.env` (local, not committed): `CORS_ORIGIN`, `FRONTEND_URL` and `VITE_API_URL` now use this PC's
  LAN IP (`172.16.71.26`) instead of `localhost`. Open the app at `http://172.16.71.26:5173` from
  every device, this PC included. If you open `localhost` while the API is set to the IP, the
  refresh cookie is cross-site and login won't stick.
- Windows Firewall needs inbound TCP 5173 and 4000 allowed (admin PowerShell).
- Known LAN-over-HTTP limit: the copy-to-clipboard buttons do nothing, because browsers only allow
  the Clipboard API on HTTPS or localhost.

## 2026-11-12 — Fix: copy buttons did nothing over LAN (plain HTTP)

`navigator.clipboard` only exists on HTTPS or localhost, so over `http://<LAN IP>:5173` every
copy button was a silent no-op (the `?.` swallowed it).

- New `frontend/src/lib/clipboard.ts` → `copyText()`: uses the Clipboard API when available,
  otherwise falls back to a hidden textarea + `document.execCommand("copy")` (works over HTTP,
  iOS-safe selection).
- New `frontend/src/components/CopyButton.tsx`: the shared document-ID copy button. It shows a green
  check mark for 1.5 s after a successful copy (before, there was no feedback at all).
- Replaced the four inline document-ID copy buttons (workspace list + grid,
  document viewer, upload panel) with `CopyButton`; the share-link copy in `ShareDialog` now uses
  `copyText()` and only shows "copied" if it actually worked.
- `tsc -b` and ESLint clean.

## 2026-11-12 — Sign-in screens redesigned; shared polish across the app

Palette and fonts unchanged (emerald / dark rail / Inter, per the 2026-07-23 reference). No logic changes.

**Signed-out frame (`components/AuthCard.tsx`)** — replaces the small card floating on an empty page:
- Two panes. Left: the dark rail with the Edoc brand, one statement ("One permanent ID for every
  document.") and a sample record showing an ID plate and three kept versions. Right: the form on
  white, 400px column, 30px title. Below `lg` the left pane is hidden and a small brand row shows.
- Every page that uses `AuthCard` gets it: login, register, forgot/reset password, verify email,
  create organization, accept invitation. `SelectOrganizationPage` now uses `AuthCard` too
  (organization rows with an initial tile and chevron instead of a text arrow).
- New shared pieces: `Field` (label tied to its input, optional action on the label row),
  `PasswordInput` (show/hide toggle), `FormAlert` (form-level error block), `Spinner`.
  New icons `EyeIcon` / `EyeOffIcon`.
- Login: "Forgot password?" sits on the password label row, autofocus + autocomplete +
  placeholders, error shown as an alert above the fields, spinner while signing in.
  Register / reset / forgot got the same field treatment.

**Shared polish (reaches every screen):**
- `inputBase`: faint shadow and a hover border. `primaryButtonBase` / `secondaryButtonBase`: pressed
  state (1px down), secondary gets a faint shadow and hover border.
- `Logomark`: soft top-to-bottom gradient with an inner highlight.
- `index.css`: `.rail-surface` (faint emerald light on the sidebar, applied in `AppShell` and
  `WorkspaceShell`), `.auth-pane`, `.plate-on-rail`. No `tailwind.config.js` change, so no dev-server
  restart is needed.

**Checked:** `tsc -b` and ESLint clean; login and register viewed in Chrome at desktop width, no
console errors. **Not checked:** the phone layout (window resize did not take), and the signed-in
screens (sidebar, buttons, inputs) — they were changed through shared styles but not viewed.

## 2026-11-12 — Sign-in frame redone as full-screen artwork (user rejected the two-pane version)

The two-pane layout with the sample record was rejected ("make it artistic"). `AuthCard` now is:
- **`AuthArt`** (inline SVG, no image file): a paper-cut landscape of six stacked hill sheets from
  deep rail green at the back to pale mint at the front, each casting a shadow on the one behind; a
  pale disc rising behind the hills; four loose pages drifting up (slow 8s drift, off under
  reduced-motion); paper grain over everything. Same greens as the app palette.
- The form on a floating white card (28px corners, deep shadow) on the right; a serif line
  ("Every page in its place.") in the sky on the left at `lg` and up.
- **Fraunces** added to the Google Fonts link in `index.html`, used for that one line only. Inter
  stays the UI font.
- Removed the now-unused `.auth-pane` and `.plate-on-rail` from `index.css`; added `.auth-page`.
- `Field`, `PasswordInput`, `FormAlert`, `Spinner` and the shared button/input polish are unchanged.

Checked: `tsc -b` + ESLint clean; login viewed in Chrome at desktop width. Phone width not viewed.

## 2026-11-13 — Sign-in: card moved left, background redrawn as a deep night valley

User feedback on the paper-cut hills version: put the form on the left, and make the artwork deeper.
- `AuthCard`: the white form card is now on the left; the serif line sits top-right, right-aligned.
- `AuthArt` redrawn: night sky with a fixed star field, a moon with a wide glow, seven ridges
  receding from near-black pine slopes at the front to pale hazy peaks at the back (each ridge
  fades to haze toward its base), mist in two valleys, pine silhouettes on the two nearest slopes,
  three loose pages drifting past the moon. Still inline SVG, same greens, paper grain kept.
  Anchored to the bottom (`xMidYMax slice`) so the foreground is never cropped on short screens.
- No change to the form, fields or any logic.

Checked: `tsc -b` + ESLint clean; login viewed in Chrome at desktop width. Phone width not viewed.

## 2026-11-13 — Sign-in background simplified

User asked for a simple design after the night-valley version. `AuthArt` is now a deep green
gradient with one soft light and three low smooth hills at the bottom edge. Removed the moon,
stars, mountain ridges, pines, mist, drifting pages and grain, plus the unused `.auth-page` CSS.
The headline is smaller, vertically centred on the right, and its sub-sentence is gone. Card stays
on the left; form unchanged. `tsc -b` + ESLint clean; viewed in Chrome at desktop width only.

## 2026-11-13 — Organization overview (Super Admin dashboard) redesigned

`pages/DashboardPage.tsx`, presentation only — same two queries, same links, palette unchanged.
- Header: "Organization overview" above the organization name; the one primary button
  ("New department") sits here. The date chip is gone.
- The four count cards became one summary band with hairline dividers (sentence-case labels,
  34px tabular figures). This also fixes the Storage tile, which used `bg-accent-tint text-accent`,
  tokens that no longer exist.
- Two columns at `xl`: Departments table on the left; Storage and Manage cards on the right.
- Departments table: sentence-case headers, icon tile per row, right-aligned member count, a thin
  bar beside each document count (relative to the busiest department), chevron to open, "View all".
  Empty state rewritten with one primary action.
- Storage card: readable backend name, status pill for verified / pending / error (pending used to
  show as red), "Last checked" date from `lastTestedAt`, total stored.
- "Quick actions" is now "Manage" with a one-line hint per row.
- The "Backend connection" bar with a raw timestamp is now one quiet status line.
- Replaced the stale "not built yet" text shown to non-Super-Admins.

Checked: `tsc -b` + ESLint clean. **Not viewed in a browser** — it needs a Super Admin sign-in.

## 2026-11-13 — Department workspace restyled (presentation only)

Palette unchanged; no logic, permission or data changes.

**Sidebar (`WorkspaceShell.tsx`, `AccountFooter.tsx`)**
- Section labels (Department / Views / Folders / Organization) are sentence case, not tracked caps.
- Each view has an icon; each folder has a folder icon.
- Selected view/folder is a raised row with a bright emerald left edge, replacing the pale mint pill.
- Confidential lock on the rail used `text-accent` (token no longer exists) — now amber.

**Main panel (`DepartmentWorkspacePage.tsx`)**
- Folder header: folder actions (Folder access / Manage access / Legal Hold, rename, move, delete)
  are right-aligned, text actions as small bordered buttons.
- Document table: sentence-case headers; title first with the ID plate + copy under it; type as a
  quiet chip; new **Uploaded** column (`uploadedAt`, shown at `lg`+); size right-aligned; "New
  version" and "Delete" are icon buttons with tooltips and aria-labels; "Open" keeps its label.
  Search/quick-view results table matches.
- Filters button shows its active count as a badge instead of "Filters · 2".
- Empty states: emerald icon tile, 17px title, 15px text. The boxed hint under the table is now one
  plain line. Two more dead `text-accent` uses replaced with `text-warning`.

Checked: `tsc -b` + ESLint clean; a folder with documents viewed in Chrome as a Department Admin,
no console errors. Not viewed: search results, quick views, trash, empty states, confidential folders.

## 2026-11-13 — Document viewer restyled (presentation only)

`pages/DocumentViewerPage.tsx`. Palette unchanged; no logic, permission or data changes.
- **Frame:** at `lg`+ the viewer is exactly window-height: the preview fills the space under the
  top bar and the details panel scrolls on its own (was a fixed 82vh preview with a gap below and a
  page scrollbar). Below `lg` it stacks as before.
- **Top bar:** bordered Back button; title with the document type under it; Delete is now a quiet
  icon button (tooltip + aria-label) so Download stays the one primary action. Status messages show
  in a tinted bar.
- **Details panel:** "Document ID" label over a larger plate; a four-fact block (type, uploaded,
  version, size); Legal Hold as a small bordered button; section titles in sentence case at 16px;
  field rows as label/value columns with dividers; versions as cards ("Version 1", current one
  tinted with a green pill, change note on its own line); activity rows with an icon disc and the
  time on a second line. All panel text is 13.5px or larger.
- Preview placeholder messages get an icon and larger text.

Checked: `tsc -b` + ESLint clean; a PDF viewed in Chrome as a Department Admin. Not viewed: image /
text / markdown previews, a held document, edit mode, multi-version history, narrow screens.

## 2026-11-13 — Fix: a failed invitation email no longer leaves a pending invitation behind

Symptom: inviting from Legal showed an error. Cause: Brevo refused the send ("unrecognised IP address"
— authorised-IP list in the Brevo account), but `createInvitation` had already saved the invitation,
so a pending row stayed behind, and the screen showed a vague error.

`backend/src/modules/invitation/invitation.service.ts`:
- `sendInviteEmail` now turns any send failure into `InvitationError(502, "email_send_failed")` with
  a plain message ("We couldn't send the invitation email, so no invitation was created…"). The
  provider's own reason goes to the server log only (`[invitation] email to … failed: …`).
- `createInvitation` deletes the just-created invitation (only if still `pending`) when the send
  fails, so retrying the same address works instead of answering "already open — resend it".
- `resendInvitation` keeps its invitation on a failed send (it had already been sent once) and gets
  the same clear message.
- No schema, audit or permission change; the "Invitation sent" audit entry is still written only after
  a successful send.

Checked: `tsc` + ESLint clean. Live against the dev backend as the HR department admin, with Brevo
still refusing: a create to a throwaway `.invalid` address returned 502 with the new message, left 0
invitation rows, and a second identical attempt gave the same 502 (not 409). Not tested: the success
path (Brevo is blocked until this PC's IP is authorised) and Resend.

Still to do in Brevo (not code): authorise this machine's IP at app.brevo.com/security/authorised_ips,
and the production server's IP before go-live. The pending invitation for the misspelled address
`vidhugovindofficoal@gmail.com` (Legal, Staff, 2026-11-13) predates this fix — revoke it on the
Members page.

## 2026-11-13 — Fix: switching organization could leave a blank "Opening workspace…" page

Cause: the sidebar's organization switch (`AccountFooter.switchOrg`) changed the token and organization
but kept React Query's cache. Landing on `/` then read the *previous* organization's cached department
list and redirected straight back into that department, which doesn't exist in the new organization,
so the workspace waited forever on "Opening workspace…". `SelectOrganizationPage` already cleared the
cache for exactly this reason (its comment says so); the sidebar switch never did.

- `components/AccountFooter.tsx`: `queryClient.clear()` after the switch, before navigating to `/`.
  A failed switch now shows a message in the sidebar instead of failing silently.
- `pages/DepartmentWorkspacePage.tsx`: when the department list has loaded and the URL's department
  isn't in it (a tab or link from another organization, or a removed department) it shows "This
  department isn't available" with a "Go to my workspace" button, instead of the endless loading text.

Reproduced and verified in Chrome with the Abate / Ajilan Personal accounts: before the fix Ajilan
Personal → Abate hung on "Opening workspace…" with the old URL; after it, both directions land on
the other organization's workspace, and opening the other organization's department URL shows the
new message. `tsc -b` + ESLint clean. Not tested: switching while on the Super Admin pages, or a
failed switch (server error) message.

## 2026-11-13 — Date fields get their own calendar (replaces the browser's native date control)

Document fields of type "date" (upload form, and the viewer's Edit form — both go through
`MetadataFields`) used `<input type="date">`, which the browser draws itself (system font, system blue,
different in every browser). Replaced with an in-app calendar.

- New `components/DatePicker.tsx`: a single-date field with the same calendar as the filters'
  `DateRangePicker` — month/year/decade choosers, locale week start, full keyboard movement
  (arrows, Home/End, PageUp/PageDown, Esc), opens above the field when there's no room below — plus a
  **Today** shortcut, a **Clear** action and a clear button on the field. Picking a day closes it.
- The value is unchanged: a `YYYY-MM-DD` string, "" for none, so nothing saved or searched changes.
- `components/upload/MetadataFields.tsx`: "date" fields render `DatePicker`; number/text unchanged.
- Refactor so both pickers share code: new `lib/calendarDates.ts` (ymd / parse / shift / withMonth,
  week start, month and weekday names) and `components/CalendarParts.tsx` (`NavButton`,
  `GridChoice`), moved out of `DateRangePicker.tsx` unchanged. `DateRangePicker` now imports them.

Checked: `tsc -b` + ESLint clean. In Chrome (HR Contract "Start Date", via the viewer's Edit form):
field shows "Select a date"; the calendar opens above the field; picking 20 Nov 2026 fills the field as
"Nov 20, 2026" with a clear button; the month chooser opens; no console errors. Nothing was saved.
Not checked: the upload panel itself (same component, but a different container), keyboard use, the
filters' range picker after the refactor (code moved only), narrow screens.

## 2026-11-14 — First production deployment started: server secured, Docker installed, records created

Followed `docs/DMS_Deployment_Guide.md` Parts 3 and 4 on the new DigitalOcean droplet (BLR1,
`s-2vcpu-4gb`, `168.144.112.26`). No application code changed.

- Server (over SSH): system updated and rebooted; user `deploy` created (uid 1000); SSH hardened
  (root login and password login off — verified from fresh connections); 2 GB swap; auto-updates
  confirmed; Docker 29.9.3 + Compose v5.7.1 installed and starting on boot.
- Deviation from the guide: `deploy` has a locked password and passwordless sudo instead of a sudo
  password (reason in `docs/DMS_Production_Details.md` §3).
- New `docs/DMS_Production_Details.md`: the real worksheet values (no secrets), the names that differ
  from the guide (R2 bucket `edoc-bucket-prod`, B2 bucket `edoc-bucket-prod-backup`), progress per guide
  part, open decisions and a dated log.
- New `PRODUCTION.local.md` (repo root) for production passwords/keys, and `.gitignore` now lists it.
  Confirmed with `git check-ignore` that it can't be committed.

Not done yet: DigitalOcean firewall and alerts, GitHub repo, domain/DNS, Brevo, R2 and B2 keys, age key,
Healthchecks (all in the user's hands). Open: no domain chosen; the repo has no git remote and the
deployment changes are uncommitted; B2 needs a second bucket for the document replica.

## 2026-11-14 — Deployment: DigitalOcean firewall done (guide 2.3)

The user created firewall `dms-prod` and applied it to the droplet: SSH 22 from one admin IP only,
HTTP 80 / HTTPS 443 / UDP 443 from everywhere, outbound at the defaults. They re-tested SSH afterwards and it
works. Recorded in `docs/DMS_Production_Details.md` (progress table, open decision 4 settled, log); the allowed IP
is in the gitignored `PRODUCTION.local.md`, not in the committed doc. Still to confirm: alerts (2.4) and
weekly droplet backups. No code changed.

## 2026-11-14 — Deployment: R2 keys recorded, domain chosen, git side of Part 1 prepared

- **Cloudflare R2 (guide 5.3):** the user created the app token (Object Read & Write) and the replica token
  (Object Read only) for `edoc-bucket-prod`. Account ID and endpoint are in `docs/DMS_Production_Details.md`;
  the keys are in the gitignored `PRODUCTION.local.md`. Each secret key was checked to be the SHA-256 of its
  token value, so the pasted values are consistent. Not yet confirmed: both tokens limited to that one bucket.
- **Decisions:** domain `edoc.abateas.app` (DNS in Cloudflare); the repo goes on the *company* GitHub account
  (name pending); a second B2 bucket `edoc-bucket-prod-replica` for the document replica (user to create).
  New open question: the email sender domain (`abateas.app` vs the guide's `abateas.com`).
- **Git side of Part 1, local only (no remote yet, nothing pushed):** `tsc` clean for backend and frontend;
  the files to be committed were scanned for keys and passwords (none). Three commits on
  `release1-v1.2-and-security`: (1) the data-protection and production-hardening work from earlier sessions
  that had never been committed — the `OCR_IMAGES_ENABLED` switch, object metadata passed to storage `put()`,
  the `data-guard` service (daily manifest + scrub), encrypted off-site backups in `deploy/backup/`,
  `docker-compose.prod.yml`, the `.env*.example` files, the Data Protection and Restore doc and the
  guide/developer docs; (2) the in-app date picker; (3) the deployment records and this file. `master` was
  fast-forwarded to it and tagged `v1.0.0`. `backend/_backfill.mts` (a one-off local scratch script with a
  hard-coded path) was left out on purpose.
