# Edoc — Release and Deployment Procedure (step by step)

How to take a change from a developer's PC to the live site `https://edoc.abateas.app`, check it, undo it if
needed, and record it. This is the procedure used for every release since go-live (`v1.0.1` on 2026-11-18,
`v1.0.2` on 2026-11-26). Follow it in order and don't skip steps. Most of the steps exist because something
went wrong without them once.

| You want to… | Read |
|---|---|
| **Release a new version of Edoc to production** | **This document** |
| Build a production server from nothing (new droplet, new accounts) | `docs/DMS_Deployment_Guide.md` |
| Day-to-day operations: backups, key rotation, logs | `deploy/README.md` |
| Restore data after an incident | `docs/developer/11_Backup_and_Restore.md`, `docs/DMS_Data_Protection_and_Restore.md` |
| See what is live right now, and the release history | `docs/DMS_Production_Details.md` |

> **No secrets in this file.** Passwords, keys and tokens are in the company password manager (vault
> "Edoc production") and, on the admin PC only, in the gitignored `PRODUCTION.local.md`.

Symbols used: 🖥️ = run on the admin/developer PC (PowerShell or Git Bash, from `C:\apps\DMS`),
🐧 = run on the production server over SSH, 🌐 = do it in a web browser.

---

## Contents

0. [Quick facts](#0-quick-facts)
1. [Rules that are never broken](#1-rules-that-are-never-broken)
2. [Versions, branches and tags](#2-versions-branches-and-tags)
3. [Decide what kind of release this is](#3-decide-what-kind-of-release-this-is)
4. [Stage A: prepare the release on the PC](#4-stage-a--prepare-the-release-on-the-pc)
5. [Stage B: publish the release (master + tag)](#5-stage-b--publish-the-release-master--tag)
6. [Stage C: deploy on the server](#6-stage-c--deploy-on-the-server)
7. [Stage D: verify the release](#7-stage-d--verify-the-release)
8. [Stage E: record the release](#8-stage-e--record-the-release)
9. [Rollback](#9-rollback)
10. [Special cases](#10-special-cases)
11. [Troubleshooting a release](#11-troubleshooting-a-release)
12. [One-page checklist](#12-one-page-checklist)
13. [Release record template](#13-release-record-template)
14. [Appendix: commands for a non-interactive SSH session](#14-appendix--commands-for-a-non-interactive-ssh-session)
15. [Appendix: release history](#15-appendix--release-history)

---

## 0. Quick facts

| Item | Value |
|---|---|
| Live site | `https://edoc.abateas.app` |
| Health check URL | `https://edoc.abateas.app/api/health` (expects `{"status":"ok",…}`) |
| Server | DigitalOcean droplet `ubuntu-s-2vcpu-4gb-blr1`, 2 vCPU / 4 GB, BLR1, public IP `168.144.112.26`, Ubuntu 24.04 |
| Server login | 🖥️ `ssh -i ~/.ssh/digitalocean deploy@168.144.112.26` (root login and password login are off; SSH is only allowed from the office's public IPs) |
| Code on the server | `~/dms` (a clone of `git@github.com:rpa-ab8/edoc.git` with a **read-only** deploy key) |
| Settings on the server | `~/dms/.env.production` (mode `600`, never in git; a copy is in the password manager) |
| Repository | `https://github.com/rpa-ab8/edoc.git` (company account, private). Push from the PC over **HTTPS**, because the PC's SSH key is not accepted for this repo |
| Branch that is live | `master`, always exactly the commit of the newest deployed tag |
| Development branch (Release 1) | `release1-v1.2-and-security` |
| Compose command on the server | `dc` (alias for `docker compose -f docker-compose.prod.yml --env-file .env.production`, run from `~/dms`) |
| Services | `web` (Caddy: HTTPS + the built frontend), `api`, `worker` (PDF text), `retention-worker`, `data-guard`, `migrate` (one-shot), `postgres`, `redis`, `backup` (cron) |
| Who may deploy | Someone with the server SSH key **and** access to the "Edoc production" vault. Deploy only when someone who can roll back is available for the next hour |
| Typical duration | About 5 minutes from backup to live for a frontend-only release (`v1.0.2`: backup 10:32 UTC, live 10:37 UTC). A migration adds its own run time |
| Downtime | A few seconds, while `api` and `web` restart. Uploads in progress at that moment fail and must be retried |

---

## 1. Rules that are never broken

1. **Backup before deploy, every time.** The pre-deploy backup is the only way back if a release breaks or
   changes data. No backup, no deploy.
2. **Only tagged commits go to production.** The server is always on a tag (`git describe --tags` shows a
   clean `vX.Y.Z`), never on a branch and never on an untagged commit.
3. **Tags never move and are never reused.** If `v1.0.3` was wrong, release `v1.0.4`. Don't delete or
   re-point a tag that has been pushed.
4. **`master` = production.** `master` only moves forward (fast-forward), and only to the commit being released.
5. **Migrations only go forward.** A release that changes the database can only be undone by restoring the
   pre-deploy backup (§9.3). Plan these releases more carefully (§10.2).
6. **No code edits on the server.** The server's working tree must stay clean (`git status` empty). Fixes
   go through git like any other change.
7. **Secrets never go in git, chat, email or tickets.** Only in `.env.production` on the server and in the
   password manager.
8. **Verify, then record.** A release is finished only when the checks in §7 pass and §8 is written.
9. **Respect the hard rules of the codebase** (`CLAUDE.md`): tenant isolation, append-only audit, immutable
   Upload Date, Legal Hold blocking every destruction path, storage only through the abstraction. A release
   that weakens any of them is not deployed.

---

## 2. Versions, branches and tags

### 2.1 Version numbers

Releases are named `vMAJOR.MINOR.PATCH`:

| Bump | When | Examples |
|---|---|---|
| **PATCH** (`v1.0.1` → `v1.0.2`) | Fixes and small UI changes, **no database migration**, no new setting | upload-panel fix (`v1.0.1`); searchable pickers (`v1.0.2`) |
| **MINOR** (`v1.0.x` → `v1.1.0`) | New features, **any database migration**, a new or changed setting in `.env.production`, a new service | a new module, a new column |
| **MAJOR** (`v1.x` → `v2.0.0`) | Release 2 of the product, or a change that needs a data conversion or a planned outage | workflow/approvals (R2 scope) |

If unsure, choose the bigger bump. A version number costs nothing.

### 2.2 Branches

```
release1-v1.2-and-security   ── day-to-day development (commits land here first)
          │
          │  fast-forward only, at release time
          ▼
master  ─────────────────────── what is live; moves only when a release is deployed
          │
          └── tags: v1.0.0, v1.0.1, v1.0.2 … (one per deployed release, annotated)
```

- Work is committed on the development branch and pushed there.
- At release time `master` is **fast-forwarded** to the release commit. No merge commits and no rebasing of
  `master`.
- If `master` has a commit the development branch lacks (it shouldn't), stop and bring that commit into
  the development branch first. Never force-push `master`.

### 2.3 Tags

Annotated tags with a one-line description of what the release contains:

```powershell
git tag -a v1.0.3 -m "v1.0.3: <one line on what changed>"
```

---

## 3. Decide what kind of release this is

🖥️ Compare the release candidate with what is live (`master`):

```powershell
git fetch origin
git log --oneline origin/master..HEAD                          # the commits going out
git diff --stat origin/master..HEAD                            # the files touched
git diff --stat origin/master..HEAD -- backend/prisma/migrations   # any migration?
git diff origin/master..HEAD -- backend/src/config/env.ts .env.production.example   # any new setting?
git diff --stat origin/master..HEAD -- docker-compose.prod.yml deploy/   # any infrastructure change?
```

Then pick the row(s) that apply. They add steps to the standard procedure:

| What changed | Release type | Extra steps |
|---|---|---|
| Frontend only (`frontend/`) | Patch | None. Lowest risk; rollback is a checkout. |
| Backend code, no migration | Patch | Read the API changes for anything touching permissions, tenant filters, audit or deletion. Run the backend suites (§4.2). |
| **A new migration** in `backend/prisma/migrations/` | Minor | §10.2 (read the SQL, decide the maintenance window, rollback means restore). |
| **A new or changed setting** in `config/env.ts` | Minor | §10.3: add the value to `~/dms/.env.production` **before** `dc up`, otherwise `api` refuses to start. |
| `docker-compose.prod.yml`, `deploy/` (Caddy, backup image) | Minor | §10.4: read the diff line by line; expect more services to restart. |
| Only `docs/` or `each_update.md` | None | No deployment needed. Push the docs and stop. (`v1.0.1` shipped docs with code; that's fine, but docs alone don't need a deploy.) |

Write down the answer. It goes in the release record (§13).

---

## 4. Stage A — prepare the release on the PC

### 4.1 Make sure the right things are committed

🖥️

```powershell
git status --short
```

- Everything that belongs to the release must be committed on the development branch and pushed.
- Things that are **not** part of the release can stay uncommitted (for example `backend/_backfill.mts`, a
  scratch file that is never committed, or a half-written doc). They don't travel with the tag, so they
  don't reach production. But they do block `git checkout master` (§5.2 shows the way round that).
- Never commit `PRODUCTION.local.md`, `.env`, `.env.production` or any key file. They are gitignored; if
  `git status` ever lists one as new, stop and find out why.

### 4.2 Run the checks

These are the same checks CI runs (`.github/workflows/ci.yml`). Run them locally first so a broken release
is caught before it is tagged.

🖥️

```powershell
npm ci                                         # only if dependencies changed
npm run lint                                   # backend + frontend ESLint
cd backend;  npx tsc --noEmit -p tsconfig.json; cd ..       # backend type check
cd frontend; npx tsc -b; npx vite build; cd ..              # frontend type check + production build
```

If backend code, permissions, sharing, audit, retention or deletion changed, also run the database suites
against a **disposable** local database (never production). See `docs/developer/08_Testing.md`:

```powershell
npm run db:mark-disposable --workspace backend
npm run check:audit-immutability --workspace backend
npm run check:tenant-isolation --workspace backend
npm run check:access-matrix --workspace backend
```

These three are the ones CI runs. `backend/package.json` has a `check:*` suite per area (`check:sharing`,
`check:upload`, `check:filters`, `check:retention`, `check:legal-hold`, …); also run the ones for the areas
the release touches. Chapter 08 explains each.

All must pass with no errors. Warnings are fixed or explained in the release record.

### 4.3 Test it by hand on a local copy

1. Start the local stack (`docker compose up -d` for Postgres and Redis, then `npm run dev:backend` and
   `npm run dev:frontend`). The local `.env` points at the LAN address; for a browser on the same PC
   you can override `CORS_ORIGIN`/`FRONTEND_URL` to `http://localhost:5173` and `VITE_API_URL` to
   `http://localhost:4000` for that session.
2. Sign in with a **local test account** (`CLAUDE.local.md`). Never use production accounts locally.
3. Walk through every screen the release touches, as a Department Admin **and** as an ordinary member.
4. Walk through one thing it shouldn't have touched (upload a PDF, search for a word inside it).

### 4.4 Write the change log entry

Add a dated section to `each_update.md` describing **what** changed, **why**, which files, the requirement
IDs (for example `SRCH-2`, `SHR-4`), and **how it was verified**. Commit it with the release.

### 4.5 Push the development branch

🖥️

```powershell
git push origin release1-v1.2-and-security
```

---

## 5. Stage B — publish the release (master + tag)

### 5.1 Choose the version

Use §2.1. Check that the tag doesn't exist yet:

```powershell
git fetch origin --tags
git tag --list "v1.*"
```

### 5.2 Fast-forward `master` to the release commit

**If the working tree is clean**:

```powershell
git checkout master
git merge --ff-only release1-v1.2-and-security
git checkout release1-v1.2-and-security
```

**If you have uncommitted files you want to keep** (common on the admin PC). `git checkout master` will
refuse with "Your local changes … would be overwritten". Don't stash or discard them. Move `master`
without switching branches:

```powershell
git fetch . release1-v1.2-and-security:master
```

This only succeeds if it is a fast-forward. If git says "non-fast-forward" / "rejected", `master` has a
commit the development branch lacks. Stop and resolve that (§2.2).

### 5.3 Tag the release commit

```powershell
git tag -a v1.0.3 -m "v1.0.3: <one line on what changed>" master
git rev-parse --short "v1.0.3^{commit}"     # must print the release commit
git rev-parse --short master                # must print the same commit
```

### 5.4 Push `master` and the tag

```powershell
git push origin master v1.0.3
git ls-remote origin master "refs/tags/v1.0.3^{}"
```

Both lines of the `ls-remote` output must show the **same** commit hash.

### 5.5 Check CI

🌐 GitHub → `rpa-ab8/edoc` → **Actions**. The push to `master` starts the CI workflow (lint, type checks,
frontend build, migration on a fresh database, the audit/tenant/access suites, Docker image builds).

- **Green:** continue.
- **Red:** don't deploy. Read the failing step, fix it on the development branch, and release the fix as
  the **next** version (the bad tag stays where it is and is never deployed; note that in §15).
- If you deploy without waiting for CI (an urgent fix), say so in the release record.

---

## 6. Stage C — deploy on the server

Do this at a quiet time. Lunch hour or after 18:00 IST is best. Tell the users who are online that the
site will blink for a few seconds.

### 6.1 Log in and look before touching anything

🖥️

```powershell
ssh -i ~/.ssh/digitalocean deploy@168.144.112.26
```

🐧

```bash
cd ~/dms
git status --short          # must print nothing (clean tree)
git describe --tags         # the release that is live now, e.g. v1.0.2. Write it down: it's your rollback target
dc ps                       # every service Up; api and postgres "healthy"
df -h /                     # at least ~5 GB free for the image build
free -h                     # memory + swap present
```

Stop and investigate if:

- `git status` shows changes. Someone edited code on the server; find out what and why first.
- A service is restarting or unhealthy **before** you start. Fix that first, or you won't know whether
  your release broke it.
- The disk is nearly full. See §11.

### 6.2 Pre-deploy backup (never skip)

🐧

```bash
dc run --rm backup backup.sh
```

Expected output, ending with:

```
[backup] <time> dumping dms@postgres
[backup] wrote /backups/dms-YYYYMMDD-HHMMSS.dump.age (<size>), verified
[backup] copied to s3://edoc-bucket-prod-backup/dms/dms-YYYYMMDD-HHMMSS.dump.age
[backup] copied manifest manifest-….jsonl.gz (encrypted)
```

- Write down the dump file name (`dms-YYYYMMDD-HHMMSS.dump.age`). It is the restore point for this release.
- `verified` and `copied to s3://…` must both appear. If the off-site copy failed, **stop**. Fix the
  backup (see `deploy/README.md` §7 and the Data Protection doc §4) before deploying.

### 6.3 (Only if the release adds settings) update `.env.production`

See §10.3. Do it now, before the new code starts.

### 6.4 Check out the release

🐧

```bash
git fetch --tags
git checkout v1.0.3
git describe --tags           # must print exactly v1.0.3
git status --short            # still clean
```

`git checkout <tag>` leaves the server in "detached HEAD" state. That is expected and correct: the server
follows tags, not a branch.

If `git fetch` fails with a permission error, the server's read-only deploy key was removed from the
GitHub repo. See §11.

### 6.5 Build and restart

🐧

```bash
dc up -d --build
```

What happens, in order:

1. The images are rebuilt from the checked-out code (frontend bundle into `web`, backend into
   `api`/`worker`/`retention-worker`/`data-guard`/`migrate`). Cached layers make an unchanged dependency
   tree fast. A dependency change takes longer on 2 vCPU.
2. `migrate` runs `prisma migrate deploy`. `api` and the workers wait for it to finish.
3. `api` starts; `web` waits for `api` to be healthy, then starts.
4. `postgres`, `redis` and `backup` are not rebuilt unless their configuration changed. They keep running.

The output ends with lines like `Container dms-prod-web-1 Started`. If any container fails, go to §11
before doing anything else.

---

## 7. Stage D — verify the release

Do every check. Copy the results into the release record (§13).

### 7.1 Migration result

🐧

```bash
dc logs --no-log-prefix migrate | tail -5
```

- No migration in this release: `No pending migrations to apply.`
- With a migration: `The following migration(s) have been applied:` followed by its name, and no error.

### 7.2 Every service is up

🐧

```bash
dc ps --format "{{.Service}}: {{.Status}}"
```

All of these must be `Up`. `api`, `postgres` and `redis` must also show `(healthy)`:
`api`, `backup`, `data-guard`, `postgres`, `redis`, `retention-worker`, `web`, `worker`.
(`migrate` has exited, which is normal. It is a one-shot job.) Run it again after a minute: a service that
was `Up 5 seconds` and is now `Restarting` is crash-looping (§11).

### 7.3 No errors in the logs

🐧

```bash
dc logs --since 10m api worker retention-worker data-guard web | grep -iE '"level":(50|60)|error|fatal' | tail -20
```

Expect nothing, or only errors you can explain. A stream of identical errors means roll back (§9).

### 7.4 Health from outside

🖥️ (or any computer)

```powershell
curl -s https://edoc.abateas.app/api/health
```

Expected: `{"status":"ok","timestamp":"…"}`.

### 7.5 The new code is really live

The frontend bundle has a new file name every release. Check it changed and contains something from this
release (a piece of new on-screen text works well):

```bash
JS=$(curl -s https://edoc.abateas.app/ | grep -o '/assets/index-[^"]*\.js' | head -1); echo "$JS"
curl -s "https://edoc.abateas.app$JS" | grep -c "<a phrase that only exists in the new version>"
```

A count of `0` means you are looking at the old bundle: a browser/CDN cache, or the `web` image was not
rebuilt. Run `dc up -d --build web` and check again.

Users with the site open keep the old version until they reload the page. Tell them to press **Ctrl + F5**
if something looks unchanged.

### 7.6 Smoke test in the browser (5–10 minutes)

🌐 Use your own production account. Do **not** create test documents in a real department unless you
delete them afterwards; prefer a department kept for testing, such as `IT`.

Always:

1. Sign in. The dashboard loads with no error banner.
2. Open a department, open a folder, open a document. The preview shows.
3. Search for a word you know is inside a PDF. It is found.
4. Open the share dialog of a document (don't create a share unless that's part of the release).

Then test **every item in this release's change list**. For example, for `v1.0.2`:

- Add document: the drop area is locked until a document type is chosen (in a department with more than
  one type).
- Share dialog: typing part of a colleague's name or email filters the people list.
- Department → Members → "Add someone who already has an account": the person can be searched.
- Filters: a dropdown field with more than 20 options shows a search box with tick boxes; one with 20 or
  fewer shows the chips.

### 7.7 Security headers still present

```powershell
curl -sI https://edoc.abateas.app | findstr /i "strict-transport x-content-type"
```

Both headers must be listed.

### 7.8 Decide: keep or roll back

- Every check passed: the release stays. Continue with §8.
- A check failed and the cause is not obvious within ~15 minutes, or users can't work: **roll back
  first, investigate afterwards** (§9). Don't debug on the live server while users are blocked.

---

## 8. Stage E — record the release

Do this the same day. The next person to touch production depends on it.

1. **`docs/DMS_Production_Details.md`**:
   - the status table at the top: "Site … (release `vX.Y.Z`, commit `<hash>`)";
   - §1 worksheet row "Release tag deployed": new tag, commit, date/time in UTC, and the previous release;
   - §6 log: one bullet, using the template in §13 (who, when, what was in it, backup file name, the check
     results, the rollback command);
   - "Last updated" at the top of the file.
2. **`each_update.md`**: a short "Release vX.Y.Z deployed to production" section (what, steps, checks).
3. **Commit and push** those two files on the development branch:

   ```powershell
   git add docs/DMS_Production_Details.md each_update.md
   git commit -m "Record the vX.Y.Z production deployment"
   git push origin release1-v1.2-and-security
   ```

   These record-keeping commits are **not** tagged or deployed. They reach `master` with the next release.
4. **Password manager**: if this release added or changed any setting in `.env.production`, update the
   copy of `.env.production` in the vault.
5. **Tell the users** (template):

   > Edoc was updated today (version vX.Y.Z). What's new: … If something looks unchanged, reload the page
   > with Ctrl + F5. Report problems to <IT contact>.

6. **PDF copies** (`docs/DMS_Documentation_Handover.md` §2): re-export only if those documents changed
   materially.

---

## 9. Rollback

### 9.1 When to roll back

- The site or API is down, or crash-looping, after the deploy.
- Users can't sign in, upload, open or search.
- Data looks wrong (missing documents, wrong permissions, someone seeing another department's documents).
  This one is an incident: roll back **and** follow `docs/DMS_Data_Protection_and_Restore.md` §4.

A cosmetic problem with an easy workaround doesn't need a rollback. Fix it in the next release.

### 9.2 Release without a migration (most releases)

🐧

```bash
cd ~/dms
git checkout v1.0.2          # the previous tag, the one you wrote down in §6.1
git describe --tags          # confirm
dc up -d --build
```

Then repeat §7.1–7.5. The database is untouched; nothing else is needed.

### 9.3 Release with a migration

Old code against a newer database schema is **not supported**. You must restore the pre-deploy backup
taken in §6.2. **Everything written to the database after that backup is lost** (uploads' metadata, shares,
edits, audit events). Check with management before doing this if the release was live for more than a few
minutes.

Uploaded *files* are not removed from R2 by a database restore. Documents uploaded after the backup will
exist as files without database rows. List them with the data-guard manifest afterwards (Data Protection
doc §5).

🐧

```bash
cd ~/dms
# 1. bring the age PRIVATE key (from the password manager / USB) to the server, temporarily:
#    🖥️ scp -i ~/.ssh/digitalocean age.key deploy@168.144.112.26:~/dms/backups/age.key
dc run --rm backup backup.sh                                   # safety dump of the current (bad) state
dc stop api worker retention-worker data-guard
git checkout v1.0.2                                            # previous tag
dc run --rm -e BACKUP_AGE_IDENTITY=/backups/age.key backup restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump.age
dc up -d --build
shred -u ~/dms/backups/age.key                                 # never leave the private key on the server
```

Then repeat §7 in full, and record the rollback in §6 of `DMS_Production_Details.md`. Include the release,
the reason, the dump restored and the time window of lost writes.

### 9.4 After any rollback

- Record it (§8), including the reason.
- The failed tag stays as it is. The fix is released as a **new** version.
- Write down in `each_update.md` what broke and what will prevent it next time.

---

## 10. Special cases

### 10.1 Urgent fix (hotfix)

Same procedure, shortened only where noted:

- §4.2 checks: still required (lint, type check, build). They take two minutes.
- §4.3 manual test: only the broken screen plus the general smoke test.
- §5.5 CI: you may deploy before CI finishes; check it afterwards and record that you did.
- §6.2 backup: **never** skipped.

### 10.2 A release with a database migration

1. Read the migration SQL (`backend/prisma/migrations/<timestamp>_<name>/migration.sql`). Look for
   `DROP`, `ALTER … TYPE`, `NOT NULL` without a default, `UPDATE`/`DELETE` of data, and new unique
   constraints that existing rows could violate.
2. Check it against the hard rules: `organization_id` on every new table except `user`; no update/delete path
   on `audit_event`; no change to the immutable `document.uploaded_at` trigger.
3. Run it on a local copy of realistic data first (a restored dump in a throwaway database, per
   `docs/developer/11_Backup_and_Restore.md`, never touching production) and time it.
4. Deploy outside working hours. Tell users in advance if it runs longer than a minute.
5. The rollback is a restore (§9.3). Make sure the age private key is at hand **before** you start.
6. Bump at least the MINOR version.

### 10.3 A release that adds or changes a setting

`api` validates its settings at start-up and refuses to start if one is missing or weak. The message names
the variable.

1. Find the new variable and its meaning in `backend/src/config/env.ts` and `.env.production.example`.
2. 🐧 Before `dc up` (between §6.2 and §6.4):

   ```bash
   cp ~/dms/.env.production ~/dms/.env.production.bak-$(date +%Y%m%d)
   nano ~/dms/.env.production          # add/change the value
   chmod 600 ~/dms/.env.production
   ```

3. Deploy as normal.
4. Update the copy of `.env.production` in the password manager (§8).
5. Delete the `.bak` file once the release is confirmed good: `shred -u ~/dms/.env.production.bak-*`.

### 10.4 A release that changes `docker-compose.prod.yml` or `deploy/`

- Read the diff line by line. Changes to `web` (Caddy) affect HTTPS and security headers. Re-check §7.7.
- Changes to `postgres` or `redis` service definitions restart them, a longer outage. Do these out of hours.
- Changes to the `backup` image: run `dc run --rm backup backup.sh` **after** the deploy as well and check
  the output (§6.2), so the nightly backup isn't silently broken.

### 10.5 Server operating-system updates

These are not releases. They are the monthly routine in the Deployment Guide Part 12
(`sudo apt update && sudo apt upgrade -y && sudo reboot`, out of hours). Don't combine one with an Edoc
release, so that if something breaks you know which change caused it.

### 10.6 Deploying from a different PC

You need: the server SSH key (password manager → save as `~/.ssh/digitalocean`, permissions restricted
to your user), an office network (the SSH firewall only allows the office's public IPs), and push access to
`rpa-ab8/edoc` over HTTPS. Clone the repo, check out the development branch, and follow this document.

---

## 11. Troubleshooting a release

| Symptom | Likely cause | What to do |
|---|---|---|
| `git checkout master` refuses: "local changes would be overwritten" | Uncommitted files on the PC | Use `git fetch . <dev-branch>:master` (§5.2). Don't discard the files. |
| `git push` asks for a password or is denied | PC's credentials for the company GitHub account expired | Sign in again with Git Credential Manager (HTTPS). The PC's SSH key is **not** accepted for this repo. |
| SSH to the server times out | You're not on an office network, or the office's public IP changed | Connect from the office. If the IP changed, a DigitalOcean admin adds it to the firewall `SSH` rule (Deployment Guide 2.3). |
| `git fetch` on the server: "Permission denied (publickey)" | The read-only deploy key was removed from GitHub | 🌐 Repo → Settings → Deploy keys: re-add the server's public key (`cat ~/.ssh/github_dms.pub` on the server; see Deployment Guide 6.1). |
| `backup.sh` fails or doesn't print `copied to s3://` | Backblaze key, bucket or network problem | Don't deploy. `deploy/README.md` §7 and Data Protection §4. |
| Build stops with "no space left on device" | Old images filling the disk | `docker image prune -f` (removes **unused** images only), then `df -h /` and retry. Never run `docker system prune --volumes`: it can delete database volumes. |
| Build is killed / very slow | Not enough memory while building on 4 GB | Check swap is on (`free -h`); stop `data-guard` during the build (`dc stop data-guard`), then `dc up -d --build`. |
| `migrate` fails | Migration error (constraint, lock, bad SQL) | `dc logs migrate`. `api` won't start on a failed migration. Roll back via §9.3 if the migration partially applied, or §9.2 if `_prisma_migrations` shows it didn't apply. Ask a developer before re-running. |
| `api` restarting, logs say "Invalid environment configuration" | A setting is missing or weak | §10.3. The message names the variable. |
| `web` won't start | It waits for a healthy `api` | Fix `api` first (`dc logs api`). |
| Site works but shows the old screens | Browser cache, or `web` not rebuilt | Ctrl + F5; check §7.5; `dc up -d --build web`. |
| Users report "Too many attempts" after the deploy | Login rate limit seeing every user as one IP | Check `TRUSTED_PROXIES` in `.env.production` (`deploy/README.md` §2, §10). |
| Email links (invitations, password reset) stop arriving | Brevo key or the authorised-IP list | Brevo → Security → Authorised IPs must contain `168.144.112.26`. |

---

## 12. One-page checklist

Print it or copy it into the release ticket. Tick each line.

```
RELEASE vX.Y.Z   date ____   deployer ____   second person available ____

A. PREPARE (PC)
[ ] git status: only intended files; nothing secret
[ ] Release type decided (§3): frontend / backend / migration / setting / compose
[ ] npm run lint, backend tsc, frontend tsc -b + vite build: all pass
[ ] DB suites run (if backend/permissions/audit/retention changed)
[ ] Manual test on local copy, as admin and as member
[ ] each_update.md entry written and committed
[ ] Development branch pushed

B. PUBLISH (PC)
[ ] Version chosen; tag doesn't exist yet
[ ] master fast-forwarded to the release commit
[ ] Annotated tag created on master; tag commit == master commit
[ ] git push origin master vX.Y.Z; ls-remote shows the same hash for both
[ ] CI green (or: deployed before CI, reason ____)

C. DEPLOY (server)
[ ] git status clean; live release noted: v_____ (rollback target)
[ ] dc ps all healthy; disk/memory OK
[ ] Backup: verified + copied to s3://  -> file: dms-________________.dump.age
[ ] .env.production updated first (only if new settings)
[ ] git fetch --tags; git checkout vX.Y.Z; git describe == vX.Y.Z
[ ] dc up -d --build completed

D. VERIFY
[ ] migrate: "No pending migrations" / migration applied with no error
[ ] dc ps: 8 services Up; api, postgres, redis healthy (checked twice, 1 min apart)
[ ] No errors in the last 10 min of logs
[ ] /api/health ok from outside
[ ] New bundle live (file name ________, contains new text)
[ ] Smoke test: sign in, open, search, share dialog
[ ] Every change in this release checked in the browser
[ ] Security headers present
[ ] Decision: KEEP / ROLLED BACK (reason ____)

E. RECORD
[ ] Production_Details: status table, worksheet row, §6 log, Last updated
[ ] each_update.md: deployment entry
[ ] Record files committed + pushed (dev branch)
[ ] Password manager updated (only if settings changed)
[ ] Users told
```

---

## 13. Release record template

Paste into `docs/DMS_Production_Details.md` §6 and fill in:

```markdown
- **Release `vX.Y.Z` deployed (YYYY-MM-DD, about HH:MM UTC)**, by <name> over SSH, following
  `docs/DMS_Release_and_Deployment_Procedure.md`. Contents: <one or two sentences>; <no migration | migration
  `<name>`>; <no new settings | new setting `<NAME>`>. `master` fast-forwarded to `<hash>` and tagged `vX.Y.Z`.
  CI: <green | not waited for, because …>. Steps: pre-deploy backup `dms-YYYYMMDD-HHMMSS.dump.age` (<size>,
  verified, copied to the B2 backups bucket); `git checkout vX.Y.Z` on the server (clean tree); `up -d --build`.
  Checked: `migrate` <result>; all 8 services up, `api` healthy; `/api/health` ok from outside; live bundle
  (`index-<hash>.js`) contains the new screens; smoke test <passed | notes>. **Rollback**: <`git checkout
  vPREVIOUS && dc up -d --build` | restore `dms-….dump.age` per the procedure §9.3>.
```

---

## 14. Appendix — commands for a non-interactive SSH session

When the deploy is driven from the PC with one-shot `ssh … '<commands>'` (for example by an automation or
an assistant), the `dc` alias is **not** loaded, because it lives in the interactive shell's profile. Use
the full command, with `$HOME` (not `~`) inside the quoted variable:

```bash
ssh -i ~/.ssh/digitalocean -o BatchMode=yes deploy@168.144.112.26 '
  DC="docker compose --project-directory $HOME/dms -f $HOME/dms/docker-compose.prod.yml --env-file $HOME/dms/.env.production"
  cd $HOME/dms && git status --short && git describe --tags
  $DC run --rm backup backup.sh 2>&1 | tail -6
'
```

```bash
ssh -i ~/.ssh/digitalocean -o BatchMode=yes deploy@168.144.112.26 '
  DC="docker compose --project-directory $HOME/dms -f $HOME/dms/docker-compose.prod.yml --env-file $HOME/dms/.env.production"
  cd $HOME/dms && git fetch --tags -q && git checkout -q vX.Y.Z && git describe --tags
  $DC up -d --build 2>&1 | tail -12
'
```

```bash
ssh -i ~/.ssh/digitalocean -o BatchMode=yes deploy@168.144.112.26 '
  DC="docker compose --project-directory $HOME/dms -f $HOME/dms/docker-compose.prod.yml --env-file $HOME/dms/.env.production"
  $DC logs --no-log-prefix migrate 2>&1 | tail -4
  $DC ps --format "{{.Service}}: {{.Status}}"
'
```

Run the backup, deploy and verify as **three separate** commands, and read each output before running
the next. Don't chain them into one command that deploys even when the backup failed.

---

## 15. Appendix — release history

| Release | Commit | Live since (UTC) | Contents | Migration | Pre-deploy backup |
|---|---|---|---|---|---|
| `v1.0.0` | `6cd195e` | 2026-11-14 | First production release (Release 1 as amended by PRD v1.2) | Initial schema | n/a (first install) |
| `v1.0.1` | `ff3ae88` | 2026-11-18 ≈ 12:24 | Upload panel: picked file not reaching the list after a folder change; new rows scroll into view | None | `dms-20261118-122339.dump.age` |
| `v1.0.2` | `d182dc8` | 2026-11-26 ≈ 10:37 | Searchable people pickers (share, add member); dropdown filters > 20 options become searchable multi-tick; searchable long dropdowns on upload; document type must be chosen before adding files | None | `dms-20261126-103232.dump.age` |

Add a row for every release, including ones that were rolled back (mark them).
