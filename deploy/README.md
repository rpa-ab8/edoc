# DMS — Production Runbook

> **Deploying for the first time?** Follow the step-by-step guide in `docs/DMS_Deployment_Guide.md`. This runbook is the day-to-day operations reference.

One server, everything in Docker Compose (Tech Stack §3.9). Sizing and cost: `docs/DMS_Budget_Plan_s-4vcpu-8gb.md`.

```
Internet ──▶ web (Caddy: HTTPS, security headers, SPA, /api proxy)
                └─▶ api (Fastify) ──▶ postgres, redis, storage (R2 or NAS)
                    worker (OCR) ───▶ postgres, redis, storage
                    migrate (one-shot: prisma migrate deploy, runs before api/worker)
                    backup (cron: pg_dump → ./backups, optional copy to R2)
```

Only `web` publishes ports (80, 443). Postgres and Redis are reachable only inside the Docker network.

Every command below runs from the repo checkout on the server. Define this alias first:

```sh
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.production'
```

---

## 1. Server preparation (once)

1. **Droplet:** DigitalOcean Basic `s-4vcpu-8gb`, Ubuntu 24.04 LTS, SSH-key login only. Region nearest to the users.
2. **Firewall** (DigitalOcean Cloud Firewall): inbound TCP 22 from your office IP only, TCP 80 and 443 from anywhere, UDP 443 from anywhere (HTTP/3). Nothing else.
3. **Docker:**
   ```sh
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # log out and back in
   ```
4. **Automatic security updates:** `sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades`.
5. **Monitoring agent and alerts:** enable DigitalOcean Monitoring on the droplet. Add alerts for CPU > 85%, memory > 85% and disk > 80%, plus a billing alert at about $100/month.
6. **Droplet backups:** enable them in the DigitalOcean panel. They give a whole-server restore point, on top of the database dumps.

## 2. DNS and Cloudflare

Point an `A` record (for example `dms.example.com`) at the droplet's IP.

- **Recommended: DNS-only (grey cloud).** Caddy gets a Let's Encrypt certificate by itself. Uploads up to the app's 120 MiB limit pass straight through. Client IPs are correct with no extra setup.
- **If you use the Cloudflare proxy (orange cloud)**, you must do all three:
  1. Set SSL/TLS mode to **Full (strict)**. Flexible will loop or fail.
  2. Set `TRUSTED_PROXIES` in `.env.production` to Cloudflare's ranges from <https://www.cloudflare.com/ips/>, space-separated. Without it, every user appears to come from a Cloudflare IP, and the login rate limits throttle whole offices.
  3. Check your plan's request-body cap. It is 100 MB on Free and Pro. Set `MAX_UPLOAD_BYTES` below it, or uploads near the limit fail at Cloudflare with no clear error.

## 3. First deploy

```sh
git clone <repo-url> dms && cd dms
cp .env.production.example .env.production
chmod 600 .env.production
```

Fill in `.env.production`. Generate the secrets on the server:

| Variable | Command | Notes |
|---|---|---|
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 32` | Hex only, because they go inside connection URLs |
| `STORAGE_CREDENTIALS_KEY` | `openssl rand -base64 32` | **Keep a copy offline** (see §8) |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | At least 32 characters; the API refuses to start otherwise |

Set `SITE_ADDRESS`, `ACME_EMAIL`, `CORS_ORIGIN` and `FRONTEND_URL` (both `https://<your domain>`), plus `BREVO_API_KEY` and `EMAIL_FROM` (the sender domain must be verified in Brevo).

```sh
dc up -d --build
dc ps                     # api healthy, migrate "Exited (0)", everything else Up
dc logs migrate           # "All migrations have been successfully applied"
curl -s https://dms.example.com/api/health
```

The first start takes a minute while Caddy obtains the certificate (`dc logs web`).

## 4. Bootstrap the first organization

Organization creation is invite-code gated (`signup_mode` defaults to `invite_code`). Create a single-use code:

```sh
CODE=$(openssl rand -hex 12)
dc exec postgres psql -U dms -d dms -c \
  "INSERT INTO signup_invite_code (id, code, \"maxUses\") VALUES (gen_random_uuid()::text, '$CODE', 1);"
echo "$CODE"
```

Then, in the browser:
1. **Create account** with the person who will be Super Admin, and verify the email. Brevo must be working.
2. **Create organization** using the code.
3. **Onboarding → Storage:** enter the R2 endpoint, bucket and keys, or the NAS mount path (see §5). The connection test must pass before you can continue.
4. **Departments:** create each from a template. A Super Admin can't read a department's documents without a role in it, so add yourself as a member if you need to.
5. **Invite people** from each department's Members tab.

Change every development or test password, and never reuse one from development.

## 5. NAS storage instead of R2

1. Mount the share on the host, for example at `/mnt/dms-nas`, using `/etc/fstab` with credentials in a root-only file.
2. In `docker-compose.prod.yml`, uncomment the `volumes:` block under `x-backend`. It mounts the share at the **same path** in both `api` and `worker`.
3. The containers run as uid **1000** (`node`), so the share must be writable by uid 1000. With CIFS, add `uid=1000,gid=1000` to the mount options.
4. In Onboarding → Storage, choose NAS and enter `/mnt/dms-nas`. The connection test writes, reads back and deletes a probe file as uid 1000.

The NAS needs its own backup. The database dumps don't include document files.

## 6. Updating

```sh
dc run --rm backup backup.sh        # restore point first, always
git fetch --tags && git checkout <release-tag>
dc up -d --build                    # migrate runs before api/worker start
dc ps && curl -s https://dms.example.com/api/health
```

Downtime is the few seconds while `api` restarts. Tag every release you deploy (`git tag -a v1.0.1 -m ...`).

### Rollback

- **Release with no migration:** `git checkout <previous-tag> && dc up -d --build`.
- **Release with a migration:** migrations only go forward, and old code against a newer schema is not supported. Check out the previous tag, then restore the pre-deploy backup from step 1 (§7), then run `dc up -d --build`.

## 7. Backups and restore

- **Schedule:** `BACKUP_CRON` (UTC, default `0 2 * * *`) writes `./backups/dms-<timestamp>.dump`, a compressed `pg_dump` custom-format file. Local copies older than `BACKUP_KEEP_DAYS` (default 14) are pruned.
- **Off-server copy (strongly recommended):** create a **separate** R2 bucket and an API token scoped to that bucket only. Set the `BACKUP_S3_*` variables, and add a lifecycle rule on the bucket to expire objects after 30–90 days. A server loss without this means losing the database.
- **On demand:** `dc run --rm backup backup.sh`
- **What's covered:** the database only (users, metadata, versions, permissions, audit trail). Document files live in R2 or on the NAS and are protected by that storage.

### Restore from backup

```sh
dc stop api worker
dc run --rm backup restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump   # replaces current contents
dc start api worker
```

Rehearse this on a scratch server every quarter. A backup you haven't restored is a hope, not a backup.

## 8. Secrets and rotation

| Secret | If leaked | To rotate |
|---|---|---|
| `JWT_ACCESS_SECRET` | Anyone can mint access tokens | Change it and run `dc up -d api`. Existing 15-minute access tokens stop working; sessions renew through refresh tokens. |
| `STORAGE_CREDENTIALS_KEY` | Saved storage credentials can be decrypted, given a DB copy | Change it, restart, then **re-enter the storage settings** in the UI, because the old ciphertext can't be read. **If it is lost, the same applies.** |
| `POSTGRES_PASSWORD` | DB access from inside the network | `dc exec postgres psql -U dms -c "ALTER USER dms PASSWORD '<new>'"`, update `.env.production`, then `dc up -d` |
| `REDIS_PASSWORD` | Queue access from inside the network | Update `.env.production`, then `dc up -d` |
| R2 / Brevo keys | Storage or mail access | Rotate at the provider. R2 keys are re-entered in the UI; Brevo goes in `.env.production`. |

Keep `.env.production` at mode `600` and out of git (it is in `.gitignore`). Store an offline copy in the company password manager.

## 9. Monitoring and logs

- **Status:** `dc ps`, `dc logs -f api`, `dc logs -f worker`. Logs are JSON, rotated at 10 MB × 5 per container.
- **Uptime:** `dc --profile monitoring up -d uptime-kuma`, then open it through a tunnel (`ssh -L 3001:127.0.0.1:3001 user@server` → <http://localhost:3001>). Monitor `https://<domain>/api/health` and point alerts at email. Self-hosted monitoring can't report its own server being down, so also add a free external check (for example UptimeRobot) on the same URL.
- **Not wired yet:** Sentry error tracking (Tech Stack §3.10). Errors currently go to `dc logs api` only.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Site down, `web` not starting | `api` unhealthy, because `web` waits for it. Check `dc logs api`, usually a config error printed at start-up. |
| `api` exits with "Invalid environment configuration" | A missing or weak value in `.env.production`. The message names the variable. |
| Certificate not issued | DNS isn't pointing at the droplet yet, port 80 is blocked, or Cloudflare is proxying with Flexible SSL. |
| Uploads fail near 100 MB with no app error | Cloudflare proxy body cap (§2). |
| Everyone gets "Too many attempts" | `TRUSTED_PROXIES` isn't set while behind the Cloudflare proxy (§2). |
| Documents stuck at OCR "pending" | `worker` is down (`dc logs worker`). The first image OCR also downloads Tesseract language data, so the server needs outbound HTTPS. |
| Storage test fails on NAS | The mount isn't writable by uid 1000, or isn't mounted in both `api` and `worker` (§5). |

## 11. Post-deploy smoke test (5 minutes)

1. Sign in as a department member, upload a PDF, open it, and search for a word inside it.
2. Create an external link, open it in a private window, then revoke it.
3. `dc run --rm backup backup.sh` succeeds, and the file appears in `./backups` (and in the R2 backup bucket, if configured).
4. `curl -sI https://<domain>` shows `Strict-Transport-Security` and `X-Content-Type-Options`.
