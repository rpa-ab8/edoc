# Scheduled PostgreSQL backups (Tech Stack §3.10): pg_dump on a cron schedule into /backups, local
# pruning, and an optional copy to S3-compatible object storage (Cloudflare R2).
# Same major version as the database image, so pg_dump/pg_restore match the server.
FROM postgres:16-alpine
RUN apk add --no-cache aws-cli
COPY entrypoint.sh backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
