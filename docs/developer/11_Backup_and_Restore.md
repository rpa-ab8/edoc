# 11 — Backup and restore (production runbook)

The hands-on runbook for **this** production system (`https://edoc.abateas.app`), with the real server, bucket and
service names. The design, the reasons behind it and the threat matrix are in
**`docs/DMS_Data_Protection_and_Restore.md`**. That document is the authority; this chapter is the copy-paste version.

- **Secrets are not in this file.** Keys, passwords and ping URLs are in the password manager (and in the gitignored
  `PRODUCTION.local.md` on the admin PC). The **age private key** lives only in the password manager and on a USB
  stick, never on the server.
- **Proven:** the monthly drill in §4 was run end to end on 2026-11-14 and passed (counts matched; the replica file's
  SHA-256 equalled the database checksum). Commands marked *(not yet run)* have not been exercised in production.
- 🖥️ = PowerShell on the admin PC · 🐧 = SSH session on the server, in `~/dms`, with the `dc` alias
  (Deployment Guide 6.3).

---

## 1. What is protected, and where

| # | Copy | Where (production) | When | Kept | Can the server delete it? |
|---|---|---|---|---|---|
| 1 | Live database | Docker volume `postgres_data` on the droplet | live | — | yes |
| 2 | Database dumps (age-encrypted) | `~/dms/backups/dms-YYYYMMDD-HHMMSS.dump.age` | 02:00 UTC (07:30 IST) | 14 days | yes |
| 3 | **Off-site database dumps** | Backblaze `edoc-bucket-prod-backup/dms/` | right after #2 | 90 days, then hidden 30 more | **no** (key has no `deleteFiles`) |
| 4 | **Off-site manifest** (storage key → document, version, folder, file name) | same bucket, `dms/manifest-*.jsonl.gz.age` | 01:30 UTC (07:00 IST), shipped with #3 | 90 days | **no** |
| 5 | Live document files | Cloudflare R2 `edoc-bucket-prod` | live | — | yes, through the app |
| 6 | **File replica** | Backblaze `edoc-bucket-prod-replica` | 03:30 UTC (09:00 IST) | deleted files kept 90 days | **no** (tested: hard delete → 401) |
| 7 | Whole droplet | DigitalOcean weekly backups | weekly | DigitalOcean's rotation | no |
| 8 | Secrets | password manager; age private key also on a USB stick | when they change | — | n/a |

Endpoints (not secret): R2 `https://0d33179a280b9470b300da005075972a.r2.cloudflarestorage.com`, Backblaze S3
`https://s3.eu-central-003.backblazeb2.com` (region `eu-central-003`).

**Monitoring.** Healthchecks.io checks `edoc-db-backup`, `edoc-data-guard` and `edoc-file-replica` (1 day period,
2 hours grace) email the admin and a second person when a job fails or doesn't run. An external uptime check
(DigitalOcean Uptime, Deployment Guide 11.1) watches `/api/health`.

**Why 3 versions can have 2 files.** Restoring an old version adds a new version row pointing at the **same** stored
object (stored files are immutable). Count versions per object, not objects, when comparing.

---

## 2. Access and tools

| What | How |
|---|---|
| Server | 🖥️ `ssh -i ~/.ssh/digitalocean deploy@168.144.112.26`. Root and password logins are off. The DigitalOcean firewall `dms-prod` allows SSH only from the office's public IPs; the office has **three** internet lines, so all three are listed. A timeout usually means a new IP, not a dead server. |
| `dc` | `docker compose --project-directory ~/dms -f ~/dms/docker-compose.prod.yml --env-file ~/dms/.env.production` |
| rclone | **1.73.0 or newer** (installed: 1.76.0 from rclone.org). Ubuntu's 1.60.1 can't log in to Backblaze any more (it only accepts login API v4). Remotes in `~/.config/rclone/rclone.conf`: `r2-docs-ro` (read-only R2 token) and `b2-offsite` (replica key). |
| age private key | Brought to the server only for a restore, then `shred -u`. |
| Commands run in containers | Files they create in `~/dms/backups` are owned by root: delete them with `rm -f`, or `rm` will stop and ask. Use `dc run -T` when piping output. |

---

## 3. Routine checks

**Weekly** (🐧, about 2 minutes):
```bash
dc ps                                   # all 8 services Up; postgres, redis, api healthy
ls -lh ~/dms/backups | tail -4          # a dump and a manifest from last night
tail -3 ~/dms-replicate.log             # "[replica] … ok" from last night
```
🌐 Healthchecks: all three checks green.

**Monthly:** the drill in §4. **Yearly:** a full rebuild on a temporary droplet (§5.4), then destroy it.

---

## 4. Monthly restore drill (about 30 minutes, proven 2026-11-14)

Restores the newest **off-site** dump into a scratch database, compares it with live, and pulls one file back from the
replica. Live data is not touched. **Run every command on its own**; don't paste several lines at once (a prompt can
swallow the following lines).

**1. Bring the key.** Copy `edoc-backup-age.key` from the USB stick (or the password manager) into your home folder,
then 🖥️:
```powershell
scp -i ~/.ssh/digitalocean "$HOME\edoc-backup-age.key" deploy@168.144.112.26:~/dms/backups/age.key
```
🐧:
```bash
cd ~/dms
chmod 600 ~/dms/backups/age.key
```

**2. Fetch and restore into `dms_drill`.** Replace the file name with the newest `dms-…dump.age` from the listing.
```bash
dc run --rm -T backup sh -c 'aws s3 ls "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/" --endpoint-url "$BACKUP_S3_ENDPOINT"'
dc run --rm -T backup sh -c 'aws s3 cp "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/dms-YYYYMMDD-HHMMSS.dump.age" /backups/drill.dump.age --endpoint-url "$BACKUP_S3_ENDPOINT"'
dc exec postgres createdb -U dms dms_drill
dc run --rm -e PGDATABASE=dms_drill -e BACKUP_AGE_IDENTITY=/backups/age.key backup sh -c '[ "$PGDATABASE" = "dms_drill" ] && restore.sh /backups/drill.dump.age'
```
✅ `[restore] restoring … into dms_drill@postgres` then `[restore] done`.

> ⚠️ `restore.sh` restores into whatever `PGDATABASE` names, and **replaces** its contents. Without
> `-e PGDATABASE=dms_drill` it would overwrite the live database. The `[ … = "dms_drill" ] &&` guard refuses to run
> otherwise. Keep it.

**3. Compare counts.**
```bash
for db in dms dms_drill; do dc exec postgres psql -U dms -d $db -tc "SELECT '$db', (SELECT count(*) FROM document), (SELECT count(*) FROM version), (SELECT count(*) FROM audit_event);"; done
```
✅ Same numbers, or live slightly higher (activity since the dump). First drill: `1 | 3 | 23` on both.

**4. Pull one file from the replica and prove it's the original.**
```bash
dc exec -T postgres psql -U dms -d dms -At -c 'SELECT "storageRef", checksum FROM version ORDER BY random() LIMIT 1;'
rclone copyto "b2-offsite:edoc-bucket-prod-replica/<storageRef>" /tmp/drill-file
file /tmp/drill-file
sha256sum /tmp/drill-file
rm -f /tmp/drill-file
```
✅ `file` names a real document type, and the `sha256sum` equals the `checksum` printed by the query, all 64
characters. (Files uploaded since last night's 03:30 run aren't in the replica yet; pick another.)

**5. Clean up.** 🐧, one line at a time:
```bash
dc exec postgres dropdb -U dms dms_drill
rm -f ~/dms/backups/drill.dump.age
shred -u ~/dms/backups/age.key
ls -l ~/dms/backups
```
✅ Only the nightly dumps and manifests are left. Then 🖥️ (PowerShell, **not** on the server):
```powershell
Remove-Item "$HOME\edoc-backup-age.key"
```

**6. Record it** in `each_update.md`: the date, the dump used, the counts, the file checked, pass or fail. Using the
USB copy one month and the password-manager copy the next proves both copies of the key.

---

## 5. Restore procedures

Before any of them: take a fresh safety dump if the database still works (`dc run --rm backup backup.sh`), and avoid
01:30–03:30 UTC, when the nightly jobs run.

### 5.1 Restore the database on the same server *(not yet run in production)*

**When:** a bad release or migration, mass accidental changes, database corruption. The server itself is fine.
**Loses:** everything changed since the dump you restore.

```bash
dc run --rm backup backup.sh                                   # safety dump of the current state, even if broken
ls -lh ~/dms/backups | grep dms-                               # pick a dump; older ones: list/download as in §4 step 2
dc stop api worker retention-worker data-guard                 # nothing may write during the restore
```
Bring the key (§4 step 1), then restore **into the live database** (the guard makes you name it on purpose):
```bash
dc run --rm -e PGDATABASE=dms -e BACKUP_AGE_IDENTITY=/backups/age.key backup sh -c '[ "$PGDATABASE" = "dms" ] && restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump.age'
dc run --rm migrate                                            # bring the schema up to the running release
dc start api worker retention-worker data-guard
dc ps
curl -s https://edoc.abateas.app/api/health
shred -u ~/dms/backups/age.key
```
Files uploaded after that dump are still in R2 but no row points at them; they're harmless and listed in that night's
manifest.

### 5.2 Put missing or damaged files back into R2 from the replica *(not yet run in production)*

**When:** the scrub reports `MISSING`/`MISMATCH`, a document won't open, or the R2 bucket was emptied.

The replica job's R2 token is read-only, so create a **temporary** remote with the read-and-write app token from the
password manager. The first and last lines keep the keys out of the shell history:
```bash
set +o history
rclone config create r2-rw s3 provider=Cloudflare access_key_id=<app key id> secret_access_key=<app secret> endpoint=https://0d33179a280b9470b300da005075972a.r2.cloudflarestorage.com no_check_bucket=true
set -o history
```
Find a document's stored files by its document ID:
```bash
dc exec postgres psql -U dms -d dms -c "SELECT v.\"versionNumber\", v.\"storageRef\", v.\"fileName\" FROM version v JOIN document d ON d.id = v.\"documentId\" WHERE d.\"documentRef\" = 'IT-XXX-2026-00001';"
```
Then:
```bash
# one file (the scrub log prints its ref=)
rclone copyto "b2-offsite:edoc-bucket-prod-replica/<storageRef>" "r2-rw:edoc-bucket-prod/<storageRef>"
# the whole bucket
rclone copy b2-offsite:edoc-bucket-prod-replica r2-rw:edoc-bucket-prod --transfers 8 --progress
# a file that was deleted from R2 (hidden in B2): list versions, copy the one you need
rclone ls --b2-versions "b2-offsite:edoc-bucket-prod-replica/<organizationId>/" | grep <uuid>
rclone copyto --b2-versions "b2-offsite:edoc-bucket-prod-replica/<storageRef>-vYYYY-MM-DD-HHMMSS-000" "r2-rw:edoc-bucket-prod/<storageRef>"
```
Afterwards:
```bash
dc run --rm data-guard node dist/worker/data-guard.js --once --scrub    # must report N/N verified
rclone config delete r2-rw
```
(Ops tooling writes to R2 directly here on purpose. Application code must still go only through the storage
abstraction.)

The Backblaze web console works too: **Browse Files → `edoc-bucket-prod-replica` → show all versions → download**.

### 5.3 Undo a mistaken permanent delete (purge) *(not yet run in production)*

The rows are gone from the live database, and the file from R2. Both still exist: the rows in the dumps from before
the purge, the file in the replica (90 days).
1. Restore the pre-purge dump into a scratch database exactly like §4 step 2, with `dms_scratch` in place of
   `dms_drill` (in the guard too).
2. Look the document up in `dms_scratch` (the §5.2 query with `-d dms_scratch`).
3. Copy its files back from the replica (§5.2, "a file that was deleted"), or simply download them and hand them to
   the user to re-upload.
4. Re-inserting the rows into the live database is a careful manual job with a developer: the document ID must stay
   the same (IDs are never reused), and versions, field values and the folder must line up. Audit rows are
   append-only; never edit existing ones.
5. `dc exec postgres dropdb -U dms dms_scratch`, `shred -u ~/dms/backups/age.key`.

### 5.4 Rebuild everything on a new server *(not yet run; rehearse yearly)*

**When:** the droplet is destroyed, unrecoverable or compromised. **Loses:** up to 24 hours (since the last dump).

**Faster option if only the droplet is broken:** DigitalOcean → droplet → **Backups** → restore the latest weekly
backup, then restore last night's dump over it (§5.1) to cut the loss from up to a week to up to a day.

Otherwise, a clean rebuild:
1. New droplet (same size, BLR1, Ubuntu 24.04), apply firewall `dms-prod`, then Deployment Guide Parts 3, 4 and
   6.1–6.3, checking out the **release tag that was running** (see `docs/DMS_Production_Details.md`).
2. `~/dms/.env.production` from the password manager (**don't** generate new secrets; the same
   `STORAGE_CREDENTIALS_KEY` keeps the saved storage connection working), `chmod 600`.
3. `mkdir -p ~/dms/backups && sudo chown 1000:1000 ~/dms/backups && chmod 700 ~/dms/backups`.
4. `dc build`, `dc up -d postgres redis`, `dc run --rm migrate`.
5. Download the newest off-site dump (§4 step 2, saving it under its own name), bring the key, restore with the
   §5.1 command, then `dc run --rm migrate`.
6. `dc up -d`, `dc ps`; sign in, open documents; run the scrub (§5.2 "Afterwards").
7. **If the IP changed:** update the DNS record `edoc` (grey cloud), **add the new IP to Brevo's Authorised IPs**
   (app.brevo.com/security/authorised_ips) or no email will send, and point the uptime check at the site again.
8. Reinstall the replica: rclone ≥ 1.73 from rclone.org, the two remotes, `/usr/local/bin/dms-replicate.sh` and
   `/etc/cron.d/dms-replicate` (Deployment Guide Part 10). Turn droplet backups on.
9. `shred -u ~/dms/backups/age.key`. **Don't** create an organization or invite code: they came back with the
   database.

### 5.5 Last resort: the database and all its dumps are lost

Users, permissions and the audit trail can't be rebuilt, but every file can be recovered with its real name,
document ID, version and folder from the newest **manifest** plus the replica. Follow
`docs/DMS_Data_Protection_and_Restore.md` §5.5 with `<backups-bucket>` = `edoc-bucket-prod-backup` and
`<replica-bucket>` = `edoc-bucket-prod-replica`, on a Linux machine with rclone ≥ 1.73, `age` and `jq`. The result
contains confidential documents: keep it on an encrypted disk and delete it afterwards.

### 5.6 Lost secrets

`docs/DMS_Data_Protection_and_Restore.md` §5.6. The one that can't be recovered is the **age private key**: if both
copies are lost, make a new key pair, set the new public key in `BACKUP_AGE_RECIPIENT`, `dc up -d backup`, and run
`dc run --rm backup backup.sh` at once; older dumps stay unreadable.

---

## 6. Problems already met in production, and their fixes

| Symptom | Cause | Fix |
|---|---|---|
| Replica fails: `This request is not currently supported on API version number 1 (400)` | rclone older than 1.73 (Ubuntu ships 1.60.1); Backblaze accepts only login API v4 | Install rclone ≥ 1.73 from rclone.org |
| `rm: remove write-protected regular file …?` | The file was created by a container (owned by root) | `rm -f`, or answer `y` |
| SSH times out at random | The office uses three public IPs; one wasn't in the firewall | List all office IPs in `dms-prod` |
| Alert email after a manual test | A failed run or a test `/fail` ping | Expected; the next successful run turns the check green |
| No uptime alert after a reboot | The reboot outage (≈15 s) is shorter than the alert threshold | Expected; test with `dc stop web` for 3–4 min if needed |
| Output piped from `dc run` looks garbled | A pseudo-terminal adds carriage returns | `dc run -T` |
