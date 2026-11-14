# 02 — Getting started

## 1. Prerequisites

- **Node.js 22** and npm (the repo is an npm workspace: `backend`, `frontend`).
- **Docker** (Docker Desktop on Windows/macOS) — for the dev Postgres and Redis.
- Git. On Windows the project is developed with PowerShell and Git Bash; both work.

## 2. First-time setup

```bash
git clone <repo> dms && cd dms
cp .env.example .env                   # then edit — see §4
# generate a storage key and paste it into STORAGE_CREDENTIALS_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

docker compose --env-file .env up -d postgres redis   # Postgres on host port 5433, Redis on 6379
npm install                                           # installs both workspaces
npm run prisma:generate --workspace backend           # generate the Prisma client
npm run prisma:migrate  --workspace backend           # apply all migrations to the dev DB
npm run prisma:seed     --workspace backend           # signup_setting row (mode = invite_code)
npm run db:mark-disposable --workspace backend        # dev DB only — lets the test suites clean up (see 08)
```

> **Never run `npm audit fix --omit=dev`** in the working tree — it reinstalls without dev dependencies and
> breaks `tsc`/`eslint`. Run `npm install` to recover.

## 3. Running it

Four terminals (or use the `:dev` variants that watch files):

| What | Command | URL / note |
|---|---|---|
| API | `npm run dev --workspace backend` | http://localhost:4000 (`GET /health`) |
| Frontend | `npm run dev --workspace frontend` | http://localhost:5173 |
| OCR worker | `npm run worker:dev --workspace backend` | needed for OCR text search; without it versions stay `ocrStatus = pending` |
| Retention worker | `npm run worker:retention:dev --workspace backend` | schedules the daily run; `npm run retention:run-once --workspace backend` runs it now and exits |

All backend scripts load the root `.env` via `dotenv -e ../.env`.

### <a id="first-organization"></a>3.1 First login on an empty database

1. Open http://localhost:5173/register and create an account. With `BREVO_API_KEY` empty, the
   verification "email" is **printed in the API console** — open the link it shows.
2. Creating an organization needs an invite code while `signup_setting.mode = invite_code` (the seeded
   default). There is no API for codes; insert one:
   ```sql
   -- docker exec -it dms-postgres-1 psql -U dms -d dms
   INSERT INTO signup_invite_code (id, code, "maxUses", "usedCount", active, "createdAt")
   VALUES (gen_random_uuid(), 'DEV-CODE-1', 10, 0, true, now());
   -- or open signup entirely for local work:
   UPDATE signup_setting SET mode = 'open' WHERE id = 1;
   ```
3. Create the organization (you become its **Super Admin**), connect storage (for local work a NAS path such as
   a temp folder is fine while `STORAGE_NAS_ROOT` is unset), create a department from a template, then invite
   or add members. Shared test accounts live in `CLAUDE.local.md` (git-ignored) — never commit credentials.

## 4. Environment variables

Validated at start-up by `backend/src/config/env.ts` (zod). An invalid value prints the field errors and exits.

### 4.1 Backend (API + workers)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. Production enables secure cookies and stricter checks. |
| `PORT` | `4000` | API listen port (binds `0.0.0.0`). |
| `DATABASE_URL` | — (required) | Postgres URL. Dev: `postgresql://dms:dms@localhost:5433/dms`. |
| `REDIS_URL` | — (required) | Redis URL (queues + login counters). |
| `CORS_ORIGIN` | `http://localhost:5173` | The only allowed browser origin (credentials on). |
| `FRONTEND_URL` | `http://localhost:5173` | Used to build links in emails (verify, reset, invitation, external link). |
| `TRUST_PROXY` | false | `true` behind Caddy so `request.ip` is the client (rate limits, lockout, login records). |
| `STORAGE_CREDENTIALS_KEY` | — (required) | 32 random bytes, base64. Encrypts `storage_config.credentials`. **Losing or changing it invalidates saved storage configs.** |
| `STORAGE_NAS_ROOT` | unset | Directory NAS mount paths must live in. Required for NAS in production; unset in dev = any path. |
| `STORAGE_R2_ALLOWED_HOSTS` | empty | Extra S3-compatible hostnames allowed besides `*.r2.cloudflarestorage.com` (comma-separated). |
| `JWT_ACCESS_SECRET` | — (required) | HS256 signing secret. In production must be ≥ 32 chars and not contain "change-me". Rotating it signs everyone out of their access tokens (refresh still works). |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Access-token lifetime. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token lifetime (rotated on each use). |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | Verification link validity. |
| `PASSWORD_RESET_TTL_MINUTES` | `60` | Reset link validity. |
| `LOGIN_MAX_ATTEMPTS` | `5` | Failures per (email, IP) before that pair is locked. |
| `LOGIN_LOCKOUT_MINUTES` | `15` | Lock + counting window. |
| `LOGIN_MAX_ATTEMPTS_PER_ACCOUNT` | `50` | Failures per email across all IPs before only trusted IPs may try. |
| `LOGIN_TRUSTED_IP_DAYS` | `30` | How far back a successful login makes an IP "trusted". |
| `MAX_UPLOAD_BYTES` | `125829120` (120 MB) | Hard upload ceiling (multipart limit). |
| `MAX_CONCURRENT_UPLOADS` | `8` | Upload slots per API process (memory bound ≈ slots × max size). |
| `MAX_CONCURRENT_UPLOADS_PER_USER` | `2` | Upload slots per user. |
| `OCR_MAX_PAGES` | `50` | Max PDF pages the OCR worker parses. |
| `OCR_IMAGES_ENABLED` | off | Tesseract OCR on JPG/PNG. Off unless `true`/`1`: images are stored `ocrStatus=done` with no text and never queued. PDF text extraction is unaffected. Production keeps it off (server sized without it). |
| `RETENTION_JOB_TIME` | `02:00` | Daily retention run, `HH:MM` 24-hour. |
| `RETENTION_JOB_TIME_ZONE` | `Asia/Kolkata` | Zone of the run time (each org's own zone decides its "today"). |
| `BREVO_API_KEY` | unset | Brevo transactional mail. Unset → mail is logged to the console. |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` | `noreply@abateas.app` / `Edoc` | Sender (must be verified in Brevo). |
| `MAIL_DISABLED` | false | `true` suppresses all outbound mail (tests). |

### 4.2 Docker compose / infrastructure

| Variable | Used by | Purpose |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | both compose files | DB credentials (prod builds `DATABASE_URL` from them). |
| `POSTGRES_PORT`, `REDIS_PORT` | dev compose | Host ports (5433 avoids clashing with a local Postgres). |
| `REDIS_PASSWORD` | prod compose | Redis `--requirepass` (prod builds `REDIS_URL`). |
| `SITE_ADDRESS`, `ACME_EMAIL` | Caddy | Public hostname (TLS via ACME) and contact email. |
| `TRUSTED_PROXIES` | Caddy | Upstream proxies whose `X-Forwarded-For`/`CF-Connecting-IP` Caddy trusts. |
| `HTTP_PORT`, `HTTPS_PORT` | prod compose | Published ports (80/443). |
| `BACKUP_CRON`, `BACKUP_KEEP_DAYS` | backup | Schedule (UTC, default `0 2 * * *`) and local retention (14 days). |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | backup | Off-site copy (B2 in production). |
| `BACKUP_REQUIRE_OFFSITE`, `BACKUP_AGE_RECIPIENT`, `BACKUP_HEALTHCHECK_URL`, `BACKUP_MIN_BYTES` | backup | Fail without an off-site copy (prod default `true`); age public key for encryption; dead-man's-switch URL; smallest acceptable dump. |
| `DATA_GUARD_TIME_UTC`, `DATA_GUARD_SCRUB_SAMPLE`, `DATA_GUARD_KEEP_DAYS`, `DATA_GUARD_DIR`, `DATA_GUARD_HEALTHCHECK_URL` | data-guard | Daily manifest + scrub (01:30 UTC, 200 files/org, 14 days, `/backups`). See `docs/DMS_Data_Protection_and_Restore.md`. |
| `IMAGE_TAG`, `ENV_FILE` | prod compose | Image tag, env file (default `.env.production`). |

### 4.3 Frontend

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` (dev), `/api` (Docker build arg) | API base URL baked into the bundle. |

## 5. npm scripts

Run with `npm run <script> --workspace backend` (or `frontend`).

**Backend**

| Script | Does |
|---|---|
| `dev` | API with file watching (`tsx watch`) |
| `worker` / `worker:dev` | OCR worker |
| `worker:retention` / `worker:retention:dev` | Retention worker (registers the daily scheduler) |
| `retention:run-once` | Run auto-delete + trash purge now, then exit (no Redis needed) |
| `build` / `start` | `tsc` to `dist/`; run the built API |
| `lint`, `format` | ESLint on `src`; Prettier |
| `prisma:generate`, `prisma:migrate`, `prisma:studio`, `prisma:seed` | Prisma client, dev migration, Studio GUI, seed |
| `db:mark-disposable` | Mark the **local dev** DB so test suites may delete their audit fixtures (refuses production / non-local) |
| `check:*` | The test suites — see [08 Testing](08_Testing.md) |

**Frontend**: `dev`, `build` (`tsc -b && vite build`), `preview`, `lint`.

Typecheck without building: `npx tsc -p tsconfig.json --noEmit` (backend), `npx tsc -b --noEmit` (frontend).

## 6. Day-to-day tips

- `npm run prisma:studio --workspace backend` is the quickest way to inspect data.
- Mail links during development appear in the API log.
- The Docker DB keeps data in the `postgres_data` volume; `docker compose down -v` wipes it (then re-run
  migrate, seed and `db:mark-disposable`).
- Every change is logged in `each_update.md` — add an entry for yours.
