#!/usr/bin/env bash
# Writes a compressed PostgreSQL dump outside the containers and outside any web root.
#   scripts/backup.sh [backup-dir]        (default: ./backups, keeps the newest 14)
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-backups}"
KEEP="${KEEP:-14}"
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file "${ENV_FILE:-deploy/.env}")
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/afterhours-$STAMP.dump"
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$FILE.partial"
mv "$FILE.partial" "$FILE"
chmod 600 "$FILE"
ls -1t "$DIR"/afterhours-*.dump | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
