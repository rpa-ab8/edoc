#!/bin/sh
# Restore a backup into the configured database. DESTRUCTIVE: existing objects are dropped and
# replaced. Stop the api and worker first (see deploy/README.md → "Restore from backup").
#
#   restore.sh /backups/dms-20261017-020000.dump
set -eu
FILE="${1:?usage: restore.sh /backups/<file>.dump}"
[ -f "$FILE" ] || { echo "[restore] no such file: $FILE" >&2; exit 1; }

echo "[restore] restoring ${FILE} into ${PGDATABASE}@${PGHOST} — current contents will be replaced"
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$PGDATABASE" "$FILE"
echo "[restore] done"
