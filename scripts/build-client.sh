#!/usr/bin/env bash
# Builds the static client with the realtime origin baked in and copies it to a web root.
#   scripts/build-client.sh https://realtime.example.com /var/www/after-hours/client
set -euo pipefail
REALTIME_URL="${1:?usage: build-client.sh <realtime-origin> <destination-dir>}"
DEST="${2:?usage: build-client.sh <realtime-origin> <destination-dir>}"
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
docker build -f deploy/Dockerfile --target client-dist \
  --build-arg VITE_REALTIME_URL="$REALTIME_URL" \
  ${NPM_CA:+--secret id=npm_ca,src="$NPM_CA"} \
  --output type=local,dest="$TMP" .
mkdir -p "$DEST"
# Copy new hashed assets first, then index.html, so no visitor sees a page without its assets.
rsync -a "$TMP/assets/" "$DEST/assets/" 2>/dev/null || cp -r "$TMP/assets/." "$DEST/assets/"
find "$TMP" -maxdepth 1 -type f ! -name index.html -exec cp {} "$DEST/" \;
cp "$TMP/index.html" "$DEST/index.html"
echo "Client deployed to $DEST (realtime origin: $REALTIME_URL)"
