# 09 — Deployment & operations

Two operator documents already exist and stay authoritative:
- **`docs/DMS_Deployment_Guide.md`** — the click-by-click first deployment (server, DNS, secrets, first org).
- **`deploy/README.md`** — the day-to-day runbook (updates, rollback, backups/restore, secrets rotation).

This chapter is the developer's map of the production system and what code changes mean for it.

## 1. Production topology

One server (DigitalOcean `s-4vcpu-8gb`, Ubuntu 24.04), everything in Docker Compose
(`docker-compose.prod.yml`, project name `dms-prod`). Only `web` publishes ports.

| Service | Image / command | Depends on | Notes |
|---|---|---|---|
| `web` | `frontend/Dockerfile` → Caddy 2.8 serving `dist` | api | Ports 80/443 (+443/udp). TLS via ACME, security headers, `/api/*` → `api:4000` (prefix stripped), SPA fallback, 130 MB body cap. |
| `api` | `backend/Dockerfile` → `node dist/index.js` (user `node`, uid 1000) | migrate ✓, redis healthy | Healthcheck `GET /health` every 15 s. `NODE_ENV=production`, `TRUST_PROXY=true`. |
| `worker` | same image → `node dist/worker/ocr.worker.js` | | OCR. |
| `retention-worker` | same image → `node dist/worker/retention.worker.js` | | Daily 02:00 `RETENTION_JOB_TIME_ZONE`. |
| `migrate` | same image → `npx prisma migrate deploy` | postgres healthy | One-shot; api/workers wait for it to complete. |
| `postgres` | `postgres:16-alpine`, volume `postgres_data` | | Not published. |
| `redis` | `redis:7-alpine`, `--requirepass`, AOF on, volume `redis_data` | | Not published. |
| `backup` | `deploy/backup` (postgres:16-alpine + aws cli + cron) | postgres healthy | `pg_dump -Fc` to `./backups`, prune after `BACKUP_KEEP_DAYS`, optional copy to an S3 bucket. |
| `uptime-kuma` | `louislam/uptime-kuma:1`, profile `monitoring` | | `127.0.0.1:3001` only — reach over an SSH tunnel. |

The backend services share the `x-backend` anchor: env file `.env.production`, `DATABASE_URL` and `REDIS_URL`
built from the compose secrets, json-file logs (10 MB × 5). For NAS storage, the share is mounted at the
**same path** into api, worker and retention-worker, and `STORAGE_NAS_ROOT` must be set.

## 2. Build and release flow

```
dc run --rm backup backup.sh     # restore point
git checkout <release-tag>
dc up -d --build                 # builds images; migrate runs first; api restarts (seconds of downtime)
dc ps && curl -s https://<site>/api/health
```
(`dc` = `docker compose -f docker-compose.prod.yml --env-file .env.production`.) Migrations only move forward;
rolling back a release that migrated means restoring the pre-deploy dump.

CI (`.github/workflows/ci.yml`, on push to main/master and PRs): `npm ci` → prisma generate → lint → backend
typecheck → frontend build → migrate a fresh Postgres → mark it disposable → audit-immutability,
tenant-isolation and access-matrix suites → Docker image builds.

## 3. What code changes imply for operations

| If you change… | Then… |
|---|---|
| `schema.prisma` / a migration | It runs automatically on deploy via `migrate`. Destructive or risky ones need a `down.sql` and a backup first. Never edit an applied migration. |
| An env var | Add it to `config/env.ts` (with a default if possible), both `.env*.example` files, chapter 02, and the deploy docs. Validation failure stops the container — `dc logs api`. |
| A worker | It's a separate container: `dc up -d --build worker retention-worker`. |
| Storage behaviour | NAS needs the volume in api **and** both workers; R2 hosts outside `*.r2.cloudflarestorage.com` need `STORAGE_R2_ALLOWED_HOSTS`. |
| Upload limits | Keep Caddy's `request_body max_size` (130 MB) above `MAX_UPLOAD_BYTES`; behind Cloudflare also below its plan cap (100 MB on Free/Pro). |
| Rate limits / IPs | Behind a proxy, `TRUSTED_PROXIES` (Caddy) must list it, or all users share one IP for rate limits and lockout. |

## 4. Backups and restore

- **What's in a backup**: the whole database (users, metadata, versions, permissions, audit trail). **Not** the
  document files — those live in R2 (or the NAS, which needs its own backup).
- **Restore** (`deploy/backup/restore.sh`): `pg_restore --clean --if-exists --no-owner --single-transaction`.
  Stop `api worker retention-worker` first. The audit append-only trigger is part of the dump and comes back with
  it; `--clean` drops and recreates tables (it doesn't DELETE rows), so the trigger doesn't block a restore.
- Rehearse quarterly on a scratch server.

## 5. Monitoring and logs

- Container health: `dc ps` (api healthcheck), `GET /api/health`.
- Logs: `dc logs -f api` (Fastify JSON logs; `debug` level in dev, `info` in prod), `dc logs worker`,
  `dc logs retention-worker` (one summary line per daily run: moved, held, failed, purged), `dc logs web`
  (Caddy JSON access log).
- Uptime Kuma (optional profile) for external checks; DigitalOcean alerts for CPU/memory/disk.

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `api` restarting | `dc logs api` — "Invalid environment configuration" names the bad variable (weak `JWT_ACCESS_SECRET`, malformed `STORAGE_CREDENTIALS_KEY`, missing `DATABASE_URL`). |
| `migrate` exited non-zero | A migration failed; api won't start. Read `dc logs migrate`; fix forward with a new migration, or restore. |
| Everyone gets 429 at login | Proxy IPs not trusted (`TRUSTED_PROXIES`) — all clients look like one IP. |
| Uploads fail near the size limit | Caddy/Cloudflare body caps vs `MAX_UPLOAD_BYTES`. |
| `429 upload_busy` under load | Upload slots exhausted; raise `MAX_CONCURRENT_UPLOADS` only if RAM allows (≈ slots × 120 MB). |
| OCR text never appears | `worker` not running or failing (`dc logs worker`); versions stay `pending` / `failed`. Metadata search still works. |
| Storage errors on every upload | `POST /storage/config/test` from the UI; R2 credentials rotated? NAS mount missing in a container? `storage_credentials_unreadable` = `STORAGE_CREDENTIALS_KEY` changed. |
| "NAS storage isn't enabled" | `STORAGE_NAS_ROOT` not set in production. |
| Emails not arriving | `BREVO_API_KEY`, verified sender for `EMAIL_FROM`, `MAIL_DISABLED` not true. |
| Auto-delete didn't run | `dc logs retention-worker`; `RETENTION_JOB_TIME(_ZONE)`; run once: `dc exec retention-worker node dist/worker/retention.worker.js --once`. |
| A user still has access after being disabled | They shouldn't — access is re-checked per request. Check that it was the org-level disable (memberships) or `user.status`. |

## 7. Operational rules

- **Never** run `db:mark-disposable` against production (it refuses `NODE_ENV=production` and non-local hosts,
  but don't try). Production must have no audit delete path.
- **Never** change `STORAGE_CREDENTIALS_KEY` without re-entering the storage connection afterwards.
- Keep `.env.production` mode `600`; keep offline copies of the secrets (see the runbook's rotation table).
- Test credentials from development must never be reused in production.

## 8. Open infrastructure work (from `SECURITY_AUDIT.md`)

| Item | What's needed |
|---|---|
| M-1 part 2 | Run `api`/workers as a Postgres role with only `INSERT, SELECT` on `audit_event` and no DDL; keep the owner role for `migrate`. Changes compose, secrets and these docs. |
| M-5 | Antivirus scanning of uploads (ClamAV sidecar or managed); stream uploads to storage instead of buffering; run the OCR worker in its own unprivileged container with CPU/memory/time limits. |
| M-8 | Upgrade Prisma 6 → 7 (removes the `deepmerge-ts` advisory), then add an `npm audit --omit=dev --audit-level=high` gate to CI. |
| Ops gaps | `login_attempt` grows unbounded (add pruning); `storage_config.usedBytes` isn't decremented on purge; `quotaBytes` isn't enforced. |
