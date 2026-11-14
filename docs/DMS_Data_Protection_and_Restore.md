# Edoc — Data Protection and Restore

How Edoc's data is protected, what each safeguard does, and exactly how to get data back in every failure scenario.

- **Setting it up:** `docs/DMS_Deployment_Guide.md` (Parts 5, 6 and 10). This document explains it and holds the restore procedures.
- **Day-to-day operations:** `deploy/README.md`.
- **Copy-paste runbook for the live system** (real names, the proven drill): `docs/developer/11_Backup_and_Restore.md`.

> **Read §1 even if you read nothing else.** It explains why the database and the files must both be protected, and why a backup on the same server is not a backup.

---

## 1. Why this matters: two halves that need each other

Edoc stores every document in **two places**, and neither is useful on its own:

| Store | Holds | Where it lives |
|---|---|---|
| **PostgreSQL** | Who everyone is, departments, folders, permissions, document IDs and titles, metadata, version history, shares, legal holds, the audit trail. Also, for every version, the **storage key** pointing at its file. | On the server (a Docker volume) |
| **Cloudflare R2** (or a NAS) | The file bytes only | In Cloudflare |

A file in R2 is stored under a meaningless key such as `3f2a…/9b71c0e2-…`. **Only the database knows** that this key is "HR-CON-2026-00142, Employment contract v3, in HR / Contracts / 2026".

So:

- **Lose the database and keep R2:** you have thousands of anonymous files with no names, no folders, no permissions and no history.
- **Lose R2 and keep the database:** you have a perfect catalogue that points at nothing.
- **Keep the database backup on the same server:** if the server is lost, the database and its backup go together.

**The goal:** any **one** thing (the server, the database, the backups, the R2 bucket, a file, a secret, or a person's mistake) can be lost, and everything can still be rebuilt.

---

## 2. The protection layers

| # | Copy | Where | How often | Can the server delete it? |
|---|---|---|---|---|
| 1 | Live database | Server (Docker volume `postgres_data`) | Live | Yes |
| 2 | Local database dumps | Server, `~/dms/backups` (14 days) | Nightly 02:00 UTC | Yes |
| 3 | **Off-site encrypted database dumps** | Backblaze B2 backups bucket (90 days) | Nightly, right after #2 | **No.** The key has no delete permission. It can only *hide* a file, and hidden files stay recoverable for 30 days. |
| 4 | **Off-site encrypted manifest** (storage key → file name, document, folder) | Backblaze B2 backups bucket (90 days) | Nightly | **No** (same as #3) |
| 5 | Live document files | Cloudflare R2 documents bucket | Live | Yes, through the app |
| 6 | **Replica of document files** | Backblaze B2 replica bucket (deleted files kept 90 days) | Nightly 03:30 UTC | **No.** Deletions only *hide* files, and the key cannot erase them. |
| 7 | Whole-server snapshot | DigitalOcean droplet backups | Weekly | Not from the server |
| 8 | Secrets (`.env.production`, the `age` private key) | Password manager + an offline copy | When they change | n/a |

**Two providers on purpose.** Live data is with Cloudflare and DigitalOcean. Every off-site copy is with Backblaze. A suspended account, a billing problem, a leaked Cloudflare token or a deleted R2 bucket cannot take the copies with it.

**Why not R2 versioning or a bucket lock on the documents bucket?** R2 does not support S3 bucket versioning. Its "bucket lock" would also block Edoc's own legitimate deletions (Trash purge, the auto-delete retention run). The replica in B2 gives the safety net without fighting the retention rules.

### 2.1 What protects against what

| Threat | Protected by |
|---|---|
| Disk or server failure, droplet destroyed | #3 off-site dumps + #5/#6 files |
| A bad release or migration corrupts the database | #2 / #3 dumps (one is taken before every deploy) |
| R2 bucket emptied or deleted (mistake, bug, leaked token) | #6 replica |
| One file corrupted or missing in R2 | #6 replica. Detected by the daily **scrub** (§3.3). |
| Database **and** all its dumps lost | #4 manifest + #6 replica: the files can be recovered with their real names and folders (§5.5) |
| Ransomware or an attacker on the server | #3, #4 and #6 cannot be deleted from the server, and the dumps and manifests are encrypted |
| A person purges a document by mistake | #6 replica keeps the file 90 days, and the database row is in the dumps (§5.4) |
| Backups silently stop working | Healthchecks.io alerts within a day (§4) |
| `STORAGE_CREDENTIALS_KEY` lost | Re-enter the storage settings. Data is unaffected (§5.6). |
| `age` private key lost | The off-site dumps become unreadable, so keep two copies (§5.6) |

---

## 3. What the software does

### 3.1 Nightly database backup (`backup` service, `deploy/backup/backup.sh`)

Every night at `BACKUP_CRON` (default `0 2 * * *` UTC):

1. `pg_dump` of the whole database (compressed custom format).
2. **Verifies the dump** with `pg_restore --list` and a minimum-size check. A broken or empty dump fails the run.
3. **Encrypts** it with `age` to the public key in `BACKUP_AGE_RECIPIENT`, giving `dms-YYYYMMDD-HHMMSS.dump.age`. The private key is never on the server.
4. Keeps it in `~/dms/backups` for `BACKUP_KEEP_DAYS` days (default 14).
5. **Copies it off-site** to `BACKUP_S3_BUCKET`. With `BACKUP_REQUIRE_OFFSITE=true` (the production default), a run with no off-site destination is a **failure**.
6. Encrypts the latest **manifest** (§3.2) and copies it off-site too. The manifest is never sent unencrypted.
7. Pings `BACKUP_HEALTHCHECK_URL` on success, or `…/fail` on any failure.

Run by hand any time: `dc run --rm backup backup.sh`.

### 3.2 Daily manifest (`data-guard` service, `backend/src/worker/data-guard.ts`)

Daily at `DATA_GUARD_TIME_UTC` (default 01:30, before the backup), it writes `~/dms/backups/manifest-YYYYMMDD-HHMMSS.jsonl.gz`. This holds one line per stored file version:

```json
{"organizationId":"…","versionId":"…","documentId":"…","documentRef":"HR-CON-2026-00142","title":"Employment contract",
 "versionNumber":3,"storageRef":"<org>/<uuid>","fileName":"contract.pdf","fileSize":183422,"mimeType":"application/pdf",
 "sha256":"…","folderPath":"Contracts/2026","departmentId":"…","status":"active","uploadedAt":"…","versionCreatedAt":"…"}
```

This is the **map from R2 keys to real documents**, kept outside the database. It names files and folders, including confidential ones, so it is only ever stored off-site in encrypted form.

### 3.3 Daily integrity scrub (`data-guard` service)

Straight after the manifest, it takes a random sample of `DATA_GUARD_SCRUB_SAMPLE` versions per organization (default 200). It downloads each through the storage layer, re-computes its SHA-256 and compares it with the checksum recorded at upload.

- **All match:** pings `DATA_GUARD_HEALTHCHECK_URL`.
- **Any missing or different:** logs `[data-guard] MISSING/UNREADABLE …` or `[data-guard] MISMATCH …` with the document and storage key, and pings `…/fail`. Fix it with §5.3.

Run by hand: `dc run --rm data-guard node dist/worker/data-guard.js --once` (add `--manifest` or `--scrub` for one part only).

### 3.4 Safeguards at upload

- **Checksum on write (R2).** Every upload sends its SHA-256 to R2, and R2 rejects the write if the bytes it received differ. So a file damaged in transit is never recorded as stored.
- **Self-describing objects (R2).** Each object carries metadata: organization, original file name, SHA-256 and uploader. A file found in the bucket with no database still says what it is. Files uploaded before this change don't have it, but the manifest covers them.
- **Atomic writes (NAS).** The NAS driver writes a temporary file, flushes it to disk, then renames it. A crash can never leave a half-written file under a real name.

### 3.5 Safe permanent deletion

The single destruction path (`destroyTrashedDocument`, used by Trash purge, "Empty trash" and the automatic trash purge):

1. Refuses anything under a **Legal Hold**.
2. Writes the audit event.
3. Deletes the **database rows first**, in one transaction.
4. Only then deletes the files. A failed file delete is logged as `[purge] orphan object left behind …`. It is never silently ignored, and it can never leave a document row pointing at a deleted file.

### 3.6 Nightly file replica (host cron, `/usr/local/bin/dms-replicate.sh`)

At 03:30 UTC, `rclone sync` copies new files from the R2 documents bucket to the B2 replica bucket:

- **It reads R2 with a read-only token**, so the replica job can never damage the live files.
- **Files deleted in R2 are only *hidden* in B2.** The B2 lifecycle rule removes hidden files after 90 days, and the B2 key has no delete permission. So a mistaken purge, or an emptied R2 bucket, stays recoverable for 90 days.
- **`--max-delete 500`** makes the job refuse, and alert, if an unusually large number of files disappeared from R2 since the last run. That is the signature of an accident or an attack.
- It pings its own healthcheck.
- It needs **rclone 1.73.0 or newer**. Backblaze now accepts only version 4 of its login API, and older rclone (including Ubuntu 24.04's packaged 1.60.1) fails with "not currently supported on API version number 1". The same applies to every rclone command in §5.

> ⚠️ **Retention note (compliance).** Because of the 90-day safety window, a document that was permanently deleted in Edoc (by a person or by the auto-delete retention run) still exists in the B2 replica for up to 90 days. If a regulation requires faster destruction, shorten the B2 lifecycle period. That shortens the recovery window by the same amount. This is a deliberate trade-off to confirm with whoever owns the retention policy.

---

## 4. Monitoring: how you find out something is wrong

Three Healthchecks.io checks, each expecting a ping every day:

| Check | Pinged by | Alerts when |
|---|---|---|
| `edoc-db-backup` | `backup.sh` | The dump, verification, encryption or off-site copy failed, or the job didn't run |
| `edoc-data-guard` | `data-guard` | The manifest failed, the scrub found a missing or corrupted file, or the job didn't run |
| `edoc-file-replica` | `dms-replicate.sh` | The replica failed, hit the `--max-delete` guard, or didn't run |

**When an alert arrives:**

| Alert | First look | Usual cause / fix |
|---|---|---|
| `edoc-db-backup` | `dc logs backup --tail 50` | B2 key or bucket name wrong, B2 unreachable, disk full (`df -h`), `BACKUP_AGE_RECIPIENT` missing or malformed |
| `edoc-data-guard` | `dc logs data-guard --tail 100 \| grep -E "MISMATCH\|MISSING\|failed"` | A listed file is missing or damaged in R2: restore it (§5.3). `failed` with a stack trace means a DB or storage connection problem. |
| `edoc-file-replica` | `tail -50 ~/dms-replicate.log` | "max delete" means **stop and investigate** why so many files vanished from R2 before running anything else. Otherwise, a credentials or network error. |

---

## 5. Restore procedures

All commands are 🐧 on the server, in `~/dms`, using the `dc` alias from the Deployment Guide (6.3).

### Before any restore: bring the age private key

Encrypted backups (`*.age`) need the private key you created in Deployment Guide 5.5. Copy it to the server **only for the restore**, then remove it.

🖥️ From your PC:

```powershell
scp .\edoc-backup-age.key deploy@<server-ip>:~/dms/backups/age.key
```

(Add `-i ~/.ssh/<key>` if your SSH key isn't the default. Then `chmod 600 ~/dms/backups/age.key` on the server.)

🐧 Afterwards (always):

```bash
shred -u ~/dms/backups/age.key
```

### 5.1 Restore the database on the same server

**When:** a bad release or migration, accidental mass changes, or database corruption. The server itself is fine.

1. **Pick the dump.** Local copies are the last 14 days:
   ```bash
   ls -lh ~/dms/backups/ | grep dms-
   ```
   Older ones are off-site. List and download them:
   ```bash
   dc run --rm backup sh -c 'aws s3 ls "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/" --endpoint-url "$BACKUP_S3_ENDPOINT"'
   dc run --rm backup sh -c 'aws s3 cp "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/dms-YYYYMMDD-HHMMSS.dump.age" /backups/ --endpoint-url "$BACKUP_S3_ENDPOINT"'
   ```
2. **Take a safety dump of the current state first,** even if it's broken:
   ```bash
   dc run --rm backup backup.sh
   ```
3. **Stop everything that writes:**
   ```bash
   dc stop api worker retention-worker data-guard
   ```
4. **Restore.** This replaces the current database contents:
   ```bash
   dc run --rm -e BACKUP_AGE_IDENTITY=/backups/age.key backup restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump.age
   ```
   ✅ Ends with `[restore] done`. (An old unencrypted `.dump` restores the same way, without `-e …`.)
5. **Bring the schema up to the running release** (needed if the dump is older than the code):
   ```bash
   dc run --rm migrate
   ```
6. **Start again and check:**
   ```bash
   dc start api worker retention-worker data-guard
   dc ps
   curl -s https://<your-domain>/api/health
   ```
7. **Remove the key:** `shred -u ~/dms/backups/age.key`.

**What is lost:** changes made after the dump. Files uploaded after the dump are still in R2 but no document points at them. They are harmless, and the manifest from that night lists them if you need to find one.

### 5.2 Rebuild everything on a new server

**When:** the droplet is destroyed, or unrecoverable, or compromised.

1. **Build a fresh server** with Deployment Guide Parts 2, 3, 4 and 6.1–6.3, checking out the **same release tag** that was running (from your worksheet).
2. **Restore the settings file.** Create `~/dms/.env.production` from the copy in the password manager (do not generate new secrets), then `chmod 600 .env.production`.
   - Using the **same `STORAGE_CREDENTIALS_KEY`** means the storage connection keeps working. If you don't have it, see §5.6.
   - If the server address changed, update DNS (Guide 5.1).
3. **Create the backups folder:** `mkdir -p ~/dms/backups && sudo chown 1000:1000 ~/dms/backups`.
4. **Build and start the database only:**
   ```bash
   dc build
   dc up -d postgres redis
   dc run --rm migrate
   ```
5. **Download the newest off-site dump** (§5.1 step 1) and bring the age key (above).
6. **Restore it:**
   ```bash
   dc run --rm -e BACKUP_AGE_IDENTITY=/backups/age.key backup restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump.age
   dc run --rm migrate
   ```
7. **Start everything:** `dc up -d`, then `dc ps`. Every service should be healthy.
8. **Check:** sign in, open a few documents (the files come from R2, which was never touched), and run `dc run --rm data-guard node dist/worker/data-guard.js --once --scrub`.
9. **Reinstall the file replica job** (Guide Part 10), turn droplet backups back on (Guide 2.2), and `shred -u ~/dms/backups/age.key`.
10. **Do not do Guide Part 8** (creating the organization). The organization came back with the database.

**What is lost:** up to 24 hours of changes (everything since the last nightly dump).

### 5.3 Restore missing or corrupted files from the replica

**When:** the data-guard scrub reports `MISSING` or `MISMATCH`, someone reports a document that won't open, or the R2 bucket was emptied or deleted.

The replica job uses a **read-only** R2 token, so it can't write back. For a restore, create a temporary rclone remote with the **documents** token (read and write) from the password manager:

```bash
rclone config create r2-rw s3 provider=Cloudflare \
  access_key_id=<documents key id> secret_access_key=<documents secret> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com no_check_bucket=true
```

**Find a document's storage keys** (if you have the document ID, e.g. `HR-CON-2026-00142`):

```bash
dc exec postgres psql -U dms -d dms -c \
  "SELECT v.\"versionNumber\", v.\"storageRef\", v.\"fileName\" FROM version v JOIN document d ON d.id = v.\"documentId\" WHERE d.\"documentRef\" = 'HR-CON-2026-00142';"
```

**One file** (the data-guard log already prints its `ref=`):

```bash
rclone copyto b2-offsite:<replica-bucket>/<storageRef> r2-rw:dms-documents/<storageRef>
```

**The whole bucket** (R2 emptied, or a new bucket):

```bash
rclone copy b2-offsite:<replica-bucket> r2-rw:dms-documents --transfers 16 --progress
```

To restore into a **new** bucket name instead, create it in R2, run the copy into it, then update the bucket in Edoc → **Settings → Storage** and pass the connection test.

**Afterwards:**
- Verify with `dc run --rm data-guard node dist/worker/data-guard.js --once --scrub`.
- Remove the temporary remote: `rclone config delete r2-rw`.

**A file that was deleted from R2** (it's now *hidden* in B2): list hidden versions and copy the one you need. rclone shows old or hidden versions with a `-vYYYY-MM-DD-HHMMSS-000` suffix:

```bash
rclone ls --b2-versions b2-offsite:<replica-bucket>/<organizationId>/ | grep <uuid>
rclone copyto --b2-versions "b2-offsite:<replica-bucket>/<storageRef>-v2026-11-01-033012-000" r2-rw:dms-documents/<storageRef>
```

You can also do this in the Backblaze web console: **Browse Files → the bucket → tick "Show hidden/all versions"**, then download the file.

### 5.4 Undo a mistaken permanent delete (purge)

A purged document's **database rows** are gone, and so is its file in R2. Both still exist in the last dump from before the purge and in the replica (90 days).

Restoring the whole database (§5.1) would also undo everything else since that dump, so for a single document:

1. Restore the pre-purge dump into a **scratch database**, not the live one:
   ```bash
   dc exec postgres createdb -U dms dms_scratch
   dc run --rm -e PGDATABASE=dms_scratch -e BACKUP_AGE_IDENTITY=/backups/age.key backup restore.sh /backups/dms-YYYYMMDD-HHMMSS.dump.age
   ```
2. Look up the document's rows and storage keys in `dms_scratch`, using the query in §5.3 with `-d dms_scratch`.
3. Restore its files from the replica (§5.3, "a file that was deleted").
4. **Re-inserting the rows into the live database is a manual, careful job.** The document, its versions, field values and folder must line up, and the document ID must stay the same (IDs are never reused). Do it with a developer. At the very least, the recovered file can be handed back to the user straight away and re-uploaded.
5. Drop the scratch database: `dc exec postgres dropdb -U dms dms_scratch`.

### 5.5 Last resort: the database and all its dumps are lost

The documents are still in R2 (or the replica), and the newest **manifest** in the B2 backups bucket says what each one is. You cannot rebuild Edoc's users, permissions or audit trail from it. You **can** recover every file with its real name, document ID, version and folder.

🐧 On any Linux machine with `rclone`, `age` and `jq`:
- The `b2-offsite` remote is configured as in Guide 10.2.
- A `b2-backups` remote uses the **backups** key from the password manager. It's needed because the replica key can't read the backups bucket.

```bash
 rclone config create b2-backups b2 account=<backups key ID> key=<backups key>
rclone ls b2-backups:<backups-bucket>/dms/ | grep manifest | sort -k2 | tail -1      # newest manifest
rclone copyto b2-backups:<backups-bucket>/dms/manifest-YYYYMMDD-HHMMSS.jsonl.gz.age ./manifest.jsonl.gz.age
age -d -i ./edoc-backup-age.key -o manifest.jsonl.gz manifest.jsonl.gz.age

mkdir -p recovered
gunzip -c manifest.jsonl.gz \
 | jq -r '[.storageRef, (.folderPath // "_unfiled"), .documentRef, (.versionNumber|tostring), .fileName] | @tsv' \
 | while IFS="$(printf '\t')" read -r ref folder docref ver name; do
     rclone copyto "b2-offsite:<replica-bucket>/$ref" "recovered/$folder/$docref v$ver - $name"
   done
```

The result is a `recovered/` folder tree that mirrors Edoc's folders, with files named like `HR-CON-2026-00142 v3 - contract.pdf`.

> ⚠️ This tree contains **confidential-folder** documents too. Handle it on an encrypted disk, give it only to the people entitled to it, and delete it when done.

If the manifest is also gone, the R2 object metadata (`fileName`, `organizationId`, `sha256`) still names files uploaded after this feature went live: `rclone lsjson --metadata r2-docs-ro:dms-documents`.

### 5.6 Lost secrets

| Lost | Effect | What to do |
|---|---|---|
| `.env.production` | Server can't start | Restore it from the password manager. Generating new values for `POSTGRES_PASSWORD`/`REDIS_PASSWORD`/`JWT_ACCESS_SECRET` is fine: everyone simply signs in again. |
| `STORAGE_CREDENTIALS_KEY` | Saved storage connection unreadable, so documents can't open | Set a new key, restart, then Super Admin → **Settings → Storage**: re-enter the R2 details (the documents token from the password manager) and pass the connection test. No document data is lost. |
| `age` private key | **Off-site dumps and manifests can't be decrypted** | Prevent it: two copies in different places (5.5 in the Guide). If one copy is lost, generate a **new** key pair, put the new public key in `BACKUP_AGE_RECIPIENT`, run `dc up -d backup` and `dc run --rm backup backup.sh` immediately. Dumps made before that are only readable with the old key. |
| R2 / B2 keys | Uploads, backups or the replica fail | Create new keys at the provider and update `.env.production` (backups), `~/.config/rclone/rclone.conf` (replica) or Edoc's storage settings (documents). |

---

## 6. Monthly restore drill (30 minutes)

A backup is only proven by restoring it. Once a month:

1. Bring the age key to the server (§5, "Before any restore").
2. Restore the newest **off-site** dump into a scratch database:
   ```bash
   dc run --rm -T backup sh -c 'aws s3 ls "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/" --endpoint-url "$BACKUP_S3_ENDPOINT"' | grep dump | tail -1
   dc run --rm -T backup sh -c 'aws s3 cp "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/<that file>" /backups/drill.dump.age --endpoint-url "$BACKUP_S3_ENDPOINT"'
   dc exec postgres createdb -U dms dms_drill
   dc run --rm -e PGDATABASE=dms_drill -e BACKUP_AGE_IDENTITY=/backups/age.key backup sh -c '[ "$PGDATABASE" = "dms_drill" ] && restore.sh /backups/drill.dump.age'
   ```
   > ⚠️ `restore.sh` **replaces** whatever database `PGDATABASE` names. The `[ … = "dms_drill" ] &&` guard makes the command refuse to run unless the target is the scratch database, so a mistyped command can't overwrite live data. (`-T` stops the terminal adding carriage returns to piped output.)
3. Compare a few counts with live:
   ```bash
   for db in dms dms_drill; do dc exec postgres psql -U dms -d $db -tc "SELECT '$db', (SELECT count(*) FROM document), (SELECT count(*) FROM version), (SELECT count(*) FROM audit_event);"; done
   ```
   The drill numbers should be the same as live or slightly lower (anything added since last night).
4. Pull **one** file from the replica and check it opens:
   ```bash
   rclone copyto b2-offsite:<replica-bucket>/<a storageRef from the query in §5.3> /tmp/drill-file && file /tmp/drill-file && rm /tmp/drill-file
   ```
   Better still, compare its `sha256sum` with the `checksum` column of that version: they must be equal.
5. Clean up, **one command at a time** (`drill.dump.age` was written by a container and is owned by root, so plain `rm` stops to ask and swallows any lines pasted after it):
   ```bash
   dc exec postgres dropdb -U dms dms_drill
   rm -f ~/dms/backups/drill.dump.age
   shred -u ~/dms/backups/age.key
   ```
   Then delete the temporary key copy on your PC (PowerShell): `Remove-Item "$HOME\edoc-backup-age.key"`.
6. Record it in `each_update.md`: the date, the dump used, the counts, and pass or fail.

Once a year, do the full §5.2 rebuild on a temporary droplet, then destroy that droplet.

---

## 7. Settings reference

| Variable (`.env.production`) | Default | Purpose |
|---|---|---|
| `BACKUP_CRON` | `0 2 * * *` | Dump schedule (UTC) |
| `BACKUP_KEEP_DAYS` | `14` | Local dump retention |
| `BACKUP_S3_BUCKET` / `_ENDPOINT` / `_PREFIX` | — / — / `dms` | Off-site destination (B2) |
| `BACKUP_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | B2 key: list, read and write; **no delete** |
| `BACKUP_REQUIRE_OFFSITE` | `true` | Fail the run when there's no off-site copy |
| `BACKUP_AGE_RECIPIENT` | — | age public key (`age1…`) for encryption |
| `BACKUP_HEALTHCHECK_URL` | — | Dead-man's-switch for backups |
| `BACKUP_MIN_BYTES` | `10000` | Smallest acceptable dump |
| `DATA_GUARD_TIME_UTC` | `01:30` | Manifest + scrub time |
| `DATA_GUARD_SCRUB_SAMPLE` | `200` | Files re-hashed per organization per day |
| `DATA_GUARD_KEEP_DAYS` | `14` | Local manifest retention |
| `DATA_GUARD_HEALTHCHECK_URL` | — | Dead-man's-switch for the manifest and scrub |

The file replica's settings live on the host: `/usr/local/bin/dms-replicate.sh` and `~/.config/rclone/rclone.conf`.

---

## 8. Known limits and open decisions

- **Up to 24 hours of database changes can be lost** in a full-server loss (nightly dumps). Continuous WAL archiving (pgBackRest / wal-g) would reduce that to minutes. It is not built yet.
- **The scrub checks a sample** (200 files per organization per day), not every file, so a large store is fully covered over weeks rather than daily.
- **The app still connects to Postgres as the database owner** (SECURITY_AUDIT.md M-1). A restricted role would stop a bug from dropping the audit trigger. It is not done yet.
- **There is no in-app grace period after a purge.** The file is deleted from R2 immediately and survives only in the B2 replica (90 days). An in-app "deleted files kept N days" would need a data-model change. Not decided.
- **Replica retention vs. legal destruction:** see the note in §3.6.
- **NAS deployments:** the replica job above targets R2. With a NAS, the NAS needs its own snapshot plus an off-site copy (for example `rclone sync` of the share to B2 using the same pattern), and the NAS mount must also be added to the `data-guard` service.
