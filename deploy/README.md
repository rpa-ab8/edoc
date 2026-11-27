# Edoc — Production Runbook

> **Deploying for the first time?** Follow the step-by-step guide in `docs/DMS_Deployment_Guide.md`. **Releasing a new version?** Follow `docs/DMS_Release_and_Deployment_Procedure.md` (checks, tagging, backup, deploy, verification, rollback, record). This runbook is the day-to-day operations reference.

One server, everything in Docker Compose (Tech Stack §3.9). Sizing and cost: the *Edoc Production Budget* doc (2 vCPU / 4 GB, image OCR off). `docs/DMS_Budget_Plan_s-4vcpu-8gb.md` is the earlier plan **with** OCR.

```
Internet ──▶ web (Caddy: HTTPS, security headers, SPA, /api proxy)
                └─▶ api (Fastify) ──▶ postgres, redis, storage (R2 or NAS)
                    worker (PDF text) ▶ postgres, redis, storage
                    retention-worker (daily 02:00 IST: auto-delete → Trash, then Trash purge) ───▶ postgres, redis, storage
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

1. **Droplet:** DigitalOcean Basic `s-2vcpu-4gb` (image OCR off; `s-4vcpu-8gb` only if `OCR_IMAGES_ENABLED=true`), Ubuntu 24.04 LTS, SSH-key login only. Region nearest to the users.
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
2. In `docker-compose.prod.yml`, uncomment the `volumes:` block under `x-backend`. It mounts the share at the **same path** in `api`, `worker` and `retention-worker` (the retention run deletes purged files from storage).
3. The containers run as uid **1000** (`node`), so the share must be writable by uid 1000. With CIFS, add `uid=1000,gid=1000` to the mount options.
4. Set `STORAGE_NAS_ROOT=/mnt/dms-nas` in `.env.production` and restart (`dc up -d`). In production NAS storage is refused until this is set, and any mount path outside it is refused (SECURITY_AUDIT.md M-4).
5. In Onboarding → Storage, choose NAS and enter `/mnt/dms-nas` (or a folder inside it). The connection test writes, reads back and deletes a probe file as uid 1000.

6. Add the same NAS mount to the `data-guard` service's `volumes:` too. Its list replaces the shared one, and without it the daily scrub can't read the files.

The NAS needs its own snapshots plus an off-site copy, because the database dumps don't include document files and the R2 replica job doesn't apply. See `docs/DMS_Data_Protection_and_Restore.md` §8.

## 6. Updating

Short form below. The full step-by-step, with the checks before and after and the rollback decision, is `docs/DMS_Release_and_Deployment_Procedure.md`.

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

**The full picture, every failure scenario and every restore procedure:** `docs/DMS_Data_Protection_and_Restore.md`. Setup: Deployment Guide Parts 5.3–5.6, 6.4, 7.0 and 10.

In short:

| What | Service | When (UTC) | Result |
|---|---|---|---|
| Manifest + integrity scrub | `data-guard` | 01:30 (`DATA_GUARD_TIME_UTC`) | `./backups/manifest-*.jsonl.gz`; sample of files re-hashed against the DB |
| Database dump | `backup` | 02:00 (`BACKUP_CRON`) | Verified, `age`-encrypted `./backups/dms-*.dump.age`, plus the encrypted manifest, copied to the B2 backups bucket. Fails if there's no off-site copy (`BACKUP_REQUIRE_OFFSITE`). |
| Document file replica | host cron `/usr/local/bin/dms-replicate.sh` | 03:30 | `rclone sync` R2 → B2 replica (deletions only hidden, kept 90 days) |

Each job pings a Healthchecks.io URL, and pings `/fail` on failure.

- **On demand:**
  - `dc run --rm backup backup.sh`
  - `dc run --rm data-guard node dist/worker/data-guard.js --once`
  - `/usr/local/bin/dms-replicate.sh`
- **Local copies:** pruned after `BACKUP_KEEP_DAYS` / `DATA_GUARD_KEEP_DAYS` (14).

### Restore from backup (same server, short form)

```sh
# bring the age private key first: scp it to ~/dms/backups/age.key
dc run --rm backup backup.sh                      # safety dump of the current state
dc stop api worker retention-worker data-guard
dc run --rm -e BACKUP_AGE_IDENTITY=/backups/age.key backup restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump.age
dc run --rm migrate                               # if the dump is older than the running release
dc start api worker retention-worker data-guard
shred -u ~/dms/backups/age.key
```

For a new server, lost files, an undo of a purge, or the last-resort manifest recovery, use the Data Protection doc (§5). Do the restore drill there (§6) every month. A backup you haven't restored is a hope, not a backup.

## 8. Secrets and rotation

| Secret | If leaked | To rotate |
|---|---|---|
| `JWT_ACCESS_SECRET` | Anyone can mint access tokens | Change it and run `dc up -d api`. Existing 15-minute access tokens stop working; sessions renew through refresh tokens. |
| `STORAGE_CREDENTIALS_KEY` | Saved storage credentials can be decrypted, given a DB copy | Change it, restart, then **re-enter the storage settings** in the UI, because the old ciphertext can't be read. **If it is lost, the same applies.** |
| `POSTGRES_PASSWORD` | DB access from inside the network | `dc exec postgres psql -U dms -c "ALTER USER dms PASSWORD '<new>'"`, update `.env.production`, then `dc up -d` |
| `REDIS_PASSWORD` | Queue access from inside the network | Update `.env.production`, then `dc up -d` |
| R2 / Brevo keys | Storage or mail access | Rotate at the provider. R2 keys are re-entered in the UI; Brevo goes in `.env.production`. The read-only R2 replica token lives in `~/.config/rclone/rclone.conf`. |
| B2 keys (backups / replica) | Can add or hide off-site files (never erase them) | Create a new no-delete key with the `b2` CLI (Guide 5.4 e), then update `BACKUP_S3_*` and run `dc up -d backup`, or re-run `rclone config create b2-offsite …`. Delete the old key in Backblaze. |
| `age` private key | Anyone holding it plus B2 access can read the backups | It is never on the server. If it's lost or leaked: new key pair, new `BACKUP_AGE_RECIPIENT`, `dc up -d backup`, then run a backup immediately (Data Protection §5.6). |

Keep `.env.production` at mode `600` and out of git (it is in `.gitignore`). Store an offline copy in the company password manager.

## 9. Monitoring and logs

- **Status:** `dc ps`, `dc logs -f api`, `dc logs -f worker`, `dc logs retention-worker`. Logs are JSON, rotated at 10 MB × 5 per container.
- **Retention run:** each day `retention-worker` logs one `[retention] run finished …` line with how many documents went to Trash, how many were skipped for a Legal Hold, how many were permanently removed from Trash, and any failures (each failure is also logged with its document ID). Time: `RETENTION_JOB_TIME` / `RETENTION_JOB_TIME_ZONE` in `.env.production`. To run it by hand: `dc run --rm retention-worker node dist/worker/retention.worker.js --once` — safe to repeat, a second run the same day changes nothing.
- **Uptime:** `dc --profile monitoring up -d uptime-kuma`, then open it through a tunnel (`ssh -L 3001:127.0.0.1:3001 user@server` → <http://localhost:3001>). Monitor `https://<domain>/api/health` and point alerts at email. Self-hosted monitoring can't report its own server being down, so also add a free external check (for example UptimeRobot) on the same URL.
- **Data protection:** Healthchecks.io emails when the backup, the data-guard run or the file replica fails or doesn't run. Logs: `dc logs backup`, `dc logs data-guard`, `~/dms-replicate.log`. What to do for each alert: Data Protection doc §4.
- **Not wired yet:** Sentry error tracking (Tech Stack §3.10). Errors currently go to `dc logs api` only.

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Site down, `web` not starting | `api` unhealthy, because `web` waits for it. Check `dc logs api`, usually a config error printed at start-up. |
| `api` exits with "Invalid environment configuration" | A missing or weak value in `.env.production`. The message names the variable. |
| Certificate not issued | DNS isn't pointing at the droplet yet, port 80 is blocked, or Cloudflare is proxying with Flexible SSL. |
| Uploads fail near 100 MB with no app error | Cloudflare proxy body cap (§2). |
| Everyone gets "Too many attempts" | `TRUSTED_PROXIES` isn't set while behind the Cloudflare proxy (§2). |
| PDFs stuck at text "pending" | `worker` is down (`dc logs worker`). |
| Need image OCR (scanned photos searchable) | Resize the droplet to `s-4vcpu-8gb` first, then set `OCR_IMAGES_ENABLED=true` in `.env.production` and `dc up -d`. The first image job downloads Tesseract language data, so the server needs outbound HTTPS. |
| Storage test fails on NAS | The mount isn't writable by uid 1000, or isn't mounted in both `api` and `worker` (§5). |
| Auto-deleted documents never reach Trash, or Trash never empties itself | `retention-worker` is down (`dc logs retention-worker`), or the department's auto-delete period is off. A document under a Legal Hold is never deleted — by design. |

## 11. Post-deploy smoke test (5 minutes)

1. Sign in as a department member, upload a PDF, open it, and search for a word inside it.
2. Create an external link, open it in a private window, then revoke it.
3. `dc run --rm backup backup.sh` succeeds: `verified`, `copied to s3://…`, `copied manifest …`, and the `.age` files appear in the B2 backups bucket.
4. `curl -sI https://<domain>` shows `Strict-Transport-Security` and `X-Content-Type-Options`.
