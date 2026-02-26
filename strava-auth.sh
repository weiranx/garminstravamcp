#!/bin/bash
# Run this once to authenticate with Strava and save tokens.
# Tokens are stored in the strava-tokens Docker volume.
#
# Prerequisites:
#   1. Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env
#      (get them from https://www.strava.com/settings/api)
#   2. Build the image first: docker compose build strava-mcp
#   3. Set Authorization Callback Domain to "localhost" in your Strava app settings

set -e

echo "=== Strava MCP Authentication ==="
echo ""

# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -E '^STRAVA_' | xargs)
fi

if [ -z "$STRAVA_CLIENT_ID" ] || [ -z "$STRAVA_CLIENT_SECRET" ]; then
  echo "ERROR: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set in .env"
  echo "Get them from: https://www.strava.com/settings/api"
  exit 1
fi

echo "Running authentication flow..."
echo "(A browser URL will be printed — open it to authorize)"
echo ""

docker compose run --rm \
  -p 8080:8080 \
  --entrypoint "" \
  -e STRAVA_CLIENT_ID="${STRAVA_CLIENT_ID}" \
  -e STRAVA_CLIENT_SECRET="${STRAVA_CLIENT_SECRET}" \
  strava-mcp \
  node /app/strava-auth-helper.js

echo ""
echo "Authentication complete. Tokens saved to Docker volume."
echo "You can now start the service with: docker compose up -d strava-mcp"
