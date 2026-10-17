#!/bin/sh
# With arguments, run them (e.g. `backup.sh` for an on-demand backup, `restore.sh <file>`).
# Without, run cron in the foreground on BACKUP_CRON (UTC).
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# busybox crond doesn't hand the container environment to its jobs — snapshot it for backup.sh.
export -p > /etc/backup.env
chmod 600 /etc/backup.env

SCHEDULE="${BACKUP_CRON:-0 2 * * *}"
echo "${SCHEDULE} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "[backup] schedule '${SCHEDULE}' (UTC), keeping ${BACKUP_KEEP_DAYS:-14} days in /backups" \
  "${BACKUP_S3_BUCKET:+, copying to s3://${BACKUP_S3_BUCKET}}"
exec crond -f -l 8
