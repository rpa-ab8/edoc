#!/bin/sh
# One backup run: pg_dump (custom format, compressed) → /backups, prune old local copies, and copy
# off the server when BACKUP_S3_BUCKET is set. Connection comes from PGHOST/PGUSER/PGPASSWORD/
# PGDATABASE. Document files are not included — they already live in durable storage (R2/NAS).
set -eu
if [ -f /etc/backup.env ]; then . /etc/backup.env; fi

STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="/backups/dms-${STAMP}.dump"
TMP="${FILE}.partial"
trap 'rm -f "$TMP"' EXIT

echo "[backup] $(date -u +%FT%TZ) dumping ${PGDATABASE}@${PGHOST}"
pg_dump --format=custom --no-owner --file="$TMP"
mv "$TMP" "$FILE"
echo "[backup] wrote ${FILE} ($(du -h "$FILE" | cut -f1))"

find /backups -name 'dms-*.dump' -type f -mtime +"${BACKUP_KEEP_DAYS:-14}" -print -delete \
  | sed 's/^/[backup] pruned /'

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  DEST="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-dms}/$(basename "$FILE")"
  aws s3 cp "$FILE" "$DEST" --endpoint-url "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}" --only-show-errors
  echo "[backup] copied to ${DEST}"
fi
