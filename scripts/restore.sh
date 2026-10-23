#!/usr/bin/env bash
# Restores a dump into the Compose database. Stop the game first so no room writes meanwhile.
#   scripts/restore.sh backups/afterhours-YYYYmmddTHHMMSSZ.dump
# Practise this on a clean test machine regularly: a backup is only proven by a restore.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: restore.sh <dump-file>}"
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file "${ENV_FILE:-deploy/.env}")
read -r -p "This replaces the current database contents. Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }
"${COMPOSE[@]}" stop game
"${COMPOSE[@]}" up -d db
"${COMPOSE[@]}" exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$FILE"
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d game
echo "Restored $FILE"
