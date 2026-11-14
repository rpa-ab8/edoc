#!/bin/sh
# Restore a backup into the configured database. DESTRUCTIVE: existing objects are dropped and
# replaced. Stop the api and worker first (see deploy/README.md → "Restore from backup").
#
#   restore.sh /backups/dms-20261017-020000.dump
#   BACKUP_AGE_IDENTITY=/keys/age.key restore.sh /backups/dms-20261017-020000.dump.age
set -eu
FILE="${1:?usage: restore.sh /backups/<file>.dump[.age]}"
[ -f "$FILE" ] || { echo "[restore] no such file: $FILE" >&2; exit 1; }

case "$FILE" in
  *.age)
    : "${BACKUP_AGE_IDENTITY:?encrypted backup — set BACKUP_AGE_IDENTITY to the path of the age private key}"
    PLAIN="/tmp/restore-$$.dump"
    trap 'rm -f "$PLAIN"' EXIT
    age -d -i "$BACKUP_AGE_IDENTITY" -o "$PLAIN" "$FILE"
    FILE="$PLAIN"
    ;;
esac

echo "[restore] restoring ${1} into ${PGDATABASE}@${PGHOST} — current contents will be replaced"
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$PGDATABASE" "$FILE"
echo "[restore] done"
