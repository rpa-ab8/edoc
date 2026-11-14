#!/bin/sh
# One backup run: pg_dump (custom format, compressed) → verify → optional age encryption → /backups,
# prune old local copies, and copy off the server. Connection comes from PGHOST/PGUSER/PGPASSWORD/
# PGDATABASE. Document files are not included — they live in R2/NAS (see docs: Data Protection).
#
# Environment:
#   BACKUP_S3_BUCKET / BACKUP_S3_ENDPOINT   off-site destination (a DIFFERENT account/provider than
#                                           the documents bucket)
#   BACKUP_REQUIRE_OFFSITE=true             fail the run (and alert) if no off-site copy was made
#   BACKUP_AGE_RECIPIENT=age1...            encrypt the dump to this public key (private key stays
#                                           offline — restore.sh needs it via BACKUP_AGE_IDENTITY)
#   BACKUP_HEALTHCHECK_URL                  dead-man's-switch URL (Healthchecks.io / Uptime Kuma push):
#                                           pinged on success, "/fail" appended on failure
set -eu
if [ -f /etc/backup.env ]; then . /etc/backup.env; fi

ping_hc() { # $1 = "" (success) or "/fail"
  [ -n "${BACKUP_HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_HEALTHCHECK_URL}${1:-}" || echo "[backup] healthcheck ping failed (ignored)"
}

STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="/backups/dms-${STAMP}.dump"
TMP="${FILE}.partial"
trap 'rc=$?; rm -f "$TMP"; if [ "$rc" -ne 0 ]; then echo "[backup] FAILED (exit $rc)"; ping_hc /fail; fi' EXIT

echo "[backup] $(date -u +%FT%TZ) dumping ${PGDATABASE}@${PGHOST}"
pg_dump --format=custom --no-owner --file="$TMP"

# Verify before trusting it: the archive must be readable and non-trivially sized.
pg_restore --list "$TMP" > /dev/null
SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt "${BACKUP_MIN_BYTES:-10000}" ]; then
  echo "[backup] dump is suspiciously small (${SIZE} bytes)" >&2
  exit 1
fi

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "${FILE}.age" "$TMP"
  rm -f "$TMP"
  FILE="${FILE}.age"
else
  mv "$TMP" "$FILE"
fi
echo "[backup] wrote ${FILE} ($(du -h "$FILE" | cut -f1)), verified"

find /backups \( -name 'dms-*.dump' -o -name 'dms-*.dump.age' \) -type f -mtime +"${BACKUP_KEEP_DAYS:-14}" -print -delete \
  | sed 's/^/[backup] pruned /'

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  DEST="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-dms}/$(basename "$FILE")"
  aws s3 cp "$FILE" "$DEST" --endpoint-url "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}" --only-show-errors
  echo "[backup] copied to ${DEST}"

  # The data-guard manifest (storage ref → file/document/folder map). It names files and folders, so
  # it only leaves the server encrypted.
  LATEST=$(ls -1t /backups/manifest-*.jsonl.gz 2>/dev/null | head -n 1 || true)
  if [ -n "$LATEST" ]; then
    if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
      age -r "$BACKUP_AGE_RECIPIENT" -o "${LATEST}.age" "$LATEST"
      aws s3 cp "${LATEST}.age" "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-dms}/$(basename "$LATEST").age" \
        --endpoint-url "$BACKUP_S3_ENDPOINT" --only-show-errors
      rm -f "${LATEST}.age"
      echo "[backup] copied manifest $(basename "$LATEST") (encrypted)"
    else
      echo "[backup] WARNING: manifest not copied off-site — set BACKUP_AGE_RECIPIENT so it can be encrypted" >&2
    fi
  fi
elif [ "${BACKUP_REQUIRE_OFFSITE:-false}" = "true" ]; then
  echo "[backup] BACKUP_REQUIRE_OFFSITE=true but BACKUP_S3_BUCKET is not set — no off-site copy" >&2
  exit 1
fi

ping_hc ""
