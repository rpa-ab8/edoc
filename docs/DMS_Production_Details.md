# Edoc — Production Details & Deployment Log

The live record of the **first production deployment**. It follows `docs/DMS_Deployment_Guide.md`, and this file holds the **real values** that the guide's worksheet (§0.3) asks you to keep, plus what has been done and what is left.

> **No secrets in this file.** It is committed to git. Passwords, API keys and tokens go in `PRODUCTION.local.md` (repo root, gitignored) and the password manager.

Last updated: 2026-11-14

---

## 1. Worksheet (guide §0.3)

| Item | Value | Status |
|---|---|---|
| Domain | `edoc.abateas.app`, with its DNS in Cloudflare | ✅ chosen 2026-11-14. The DNS record is not created yet (5.1) |
| Droplet name | `ubuntu-s-2vcpu-4gb-blr1` (DigitalOcean default; the guide suggests `dms-prod-1`, optional rename) | ✅ |
| Droplet public IP | `168.144.112.26` | ✅ |
| Droplet private (VPC) IP | `10.122.0.2` | ✅ |
| GitHub repo | on the **company** GitHub account (account and repo name not given yet). Not created; the local repo has no remote | ⏳ |
| Cloudflare account ID | `0d33179a280b9470b300da005075972a` | ✅ |
| R2 S3 endpoint | `https://0d33179a280b9470b300da005075972a.r2.cloudflarestorage.com` | ✅ |
| R2 documents bucket | `edoc-bucket-prod` (guide default: `dms-documents`) | ✅ created 2026-11-14. App token (Read & Write) and replica token (Read only) created; their keys are in `PRODUCTION.local.md`. To confirm: both tokens are limited to this one bucket |
| B2 region / S3 endpoint | not provided yet | ⏳ |
| B2 backups bucket | `edoc-bucket-prod-backup`, private (guide default: `abate-edoc-backups`) | ✅ created 2026-11-14 |
| B2 replica bucket | `edoc-bucket-prod-replica`, agreed 2026-11-14. **Not created yet**: the user creates it (private, default encryption on, object lock off) | ⏳ |
| age public key | not generated yet | ⏳ |
| Healthchecks URLs (db-backup / data-guard / file-replica) | not created yet | ⏳ |
| Brevo sender | not set up yet (guide: `noreply@abateas.com`) | ⏳ |
| First Super Admin email | not decided | ⏳ |
| Release tag deployed | none yet | ⏳ |

## 2. Names that differ from the guide

The guide's commands use its own example names. In every command, use the real one:

| Guide says | Use instead | Where it appears |
|---|---|---|
| `dms-documents` (R2) | `edoc-bucket-prod` | 5.3, 8.3 (onboarding), 10.2, 10.3 (`SRC=`), token names |
| `abate-edoc-backups` (B2) | `edoc-bucket-prod-backup` | 5.4 b/e, 6.4 (`BACKUP_S3_BUCKET`), 7.3, 10.6 b |
| `abate-edoc-docs-replica` (B2) | `edoc-bucket-prod-replica` | 5.4 c/e, 10.2, 10.3 (`DST=`), 10.6 c |
| `dms.abateas.com` | `edoc.abateas.app` | everywhere: `SITE_ADDRESS`, `CORS_ORIGIN`, `FRONTEND_URL`, DNS, the health check URL |
| `203.0.113.10` | `168.144.112.26` | Parts 3 and 4 (already done) |
| `dms-prod-1` | `ubuntu-s-2vcpu-4gb-blr1` | firewall / alert "apply to droplet" |

## 3. The server

| | |
|---|---|
| Provider / region | DigitalOcean, BLR1 (Bangalore) |
| Size | `s-2vcpu-4gb`: 2 vCPU, 3.8 GB RAM, 77 GB disk |
| OS | Ubuntu 24.04.5 LTS, kernel 6.8.0-147 |
| Weekly droplet backups | bought with the droplet; confirm "enabled" under droplet → **Backups** (guide 2.2 / 10.6 f) |
| Login | `ssh -i ~/.ssh/digitalocean deploy@168.144.112.26` |
| SSH key on the PC | `~/.ssh/digitalocean`, public comment `ajilan-digitalocean`, **created without a passphrase** |

### Deviation from the guide: `deploy` has no password

Guide 3.3 creates `deploy` with a password used for `sudo`. Here `deploy` has a **locked password** and **passwordless sudo** (`/etc/sudoers.d/90-deploy-user`). Reason: the account can only be reached with the SSH key, and a member of the `docker` group is root-equivalent anyway, so a sudo password adds almost nothing. To go back to the guide's way: `sudo passwd deploy`, then delete `/etc/sudoers.d/90-deploy-user`.

Worth doing later: put a passphrase on the SSH key (`ssh-keygen -p -f ~/.ssh/digitalocean`), since anyone who copies that file can log in.

## 4. Progress against the guide

| Part | What | Status |
|---|---|---|
| 0 | Accounts: DigitalOcean ✅ · Cloudflare R2 ✅ · Backblaze B2 ✅ (free tier, payment later) · domain ⏳ · Healthchecks ⏳ · Brevo ⏳ · GitHub ⏳ · password manager ⏳ · USB stick ⏳ | partly |
| 1 | Code on GitHub | ⏳ Local side prepared 2026-11-14: changes committed, `master` fast-forwarded to the release branch, tag `v1.0.0` created, nothing pushed. Waiting on the company GitHub repo, then the push (by the user, over HTTPS) |
| 2.1–2.2 | SSH key, droplet | ✅ |
| 2.3 | DigitalOcean firewall `dms-prod` | ✅ 2026-11-14 (by the user). Inbound: SSH 22 from **one admin IP only** (the IP is in `PRODUCTION.local.md`), HTTP 80, HTTPS 443, UDP 443 from everywhere. Outbound left at the defaults. SSH re-tested afterwards: works |
| 2.4 | Monitoring + billing alerts | ⏳ |
| 3 | Secure the server (update, `deploy` user, SSH hardening, swap, auto-updates) | ✅ 2026-11-14 |
| 4 | Docker | ✅ 2026-11-14 (Docker 29.9.3, Compose v5.7.1, `hello-world` OK, starts on boot) |
| 5 | R2 tokens ✅ · DNS ⏳ · Brevo ⏳ · B2 replica bucket + no-delete keys ⏳ · age key ⏳ · Healthchecks ⏳ | partly |
| 6 | Deploy key, clone, `.env.production` | ⏳ |
| 7 | Build and start | ⏳ |
| 8 | Organization, storage, first department | ⏳ |
| 9 | Verification | ⏳ |
| 10 | File replica and go-live checks | ⏳ |
| 11 | Monitoring | ⏳ |

## 5. Decisions still open

1. ~~Domain~~ — settled 2026-11-14: `edoc.abateas.app`, DNS in Cloudflare.
2. **Company GitHub account (or organization) name and the repo name.** The repo goes on the *company* account, not the personal `ajilanpt` one. This PC's SSH key for `git@github.com` is rejected, so push over HTTPS with the browser sign-in (guide 1.3). The server's clone uses its own read-only deploy key.
3. ~~Second B2 bucket~~ — agreed 2026-11-14: `edoc-bucket-prod-replica`, to be created by the user.
4. ~~Firewall SSH source~~ — settled 2026-11-14: port 22 is limited to one admin IP. If that IP changes, SSH times out; fix it by editing the SSH rule under Networking → Firewalls → `dms-prod`. (The guide's "Droplet Console" tip may not help, because root login is off.)
5. **Email sender domain.** The guide's example sender is `noreply@abateas.com`, but Edoc lives on `abateas.app`. Brevo must authenticate the domain the sender uses, and its DNS records go in that domain's Cloudflare zone. Decide before guide 5.2, and check that the chosen domain is in the same Cloudflare account.

## 6. Log

### 2026-11-14
- Droplet created by the user (DigitalOcean, BLR1, `s-2vcpu-4gb`, weekly backups). Cloudflare R2 bucket `edoc-bucket-prod` and Backblaze B2 bucket `edoc-bucket-prod-backup` created.
- Server work (guide Parts 3 and 4), done over SSH:
  - `apt update && upgrade`; rebooted for a `libc6` update.
  - Created user `deploy` (uid 1000, which `data-guard` needs in 7.0), copied the SSH key, tested login + sudo.
  - SSH hardening in `/etc/ssh/sshd_config.d/00-hardening.conf`. Verified on new connections: `deploy` can log in, `root` is refused, password login is refused.
  - 2 GB swap at `/swapfile`, in `/etc/fstab`. `unattended-upgrades` enabled. Timezone left at UTC.
  - Docker installed from `get.docker.com`; `deploy` added to the `docker` group.
- DigitalOcean firewall `dms-prod` created and applied to the droplet by the user (guide 2.3). SSH 22 is now limited to one admin IP; HTTP, HTTPS and UDP 443 are open. SSH confirmed working afterwards.
- Still to confirm: monitoring and billing alerts (2.4), and that weekly droplet backups show "enabled".
- Cloudflare R2 (guide 5.3): the user created the app token (Object Read & Write) and the replica token (Object Read only) for `edoc-bucket-prod`. The pasted keys were checked: each secret key equals the SHA-256 of its token value, so they were copied correctly. The keys are in `PRODUCTION.local.md`.
- Decisions: domain `edoc.abateas.app`; repo on the company GitHub account; second B2 bucket `edoc-bucket-prod-replica`.
- Git side of Part 1 prepared on the PC (nothing pushed): backend and frontend `tsc` clean, files to commit scanned for secrets (none), changes committed in three commits, `master` fast-forwarded, tag `v1.0.0`. `backend/_backfill.mts` (a one-off local scratch script) was deliberately left out.
