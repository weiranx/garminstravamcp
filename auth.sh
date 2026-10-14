#!/bin/bash
# Run this once to authenticate with Garmin and save tokens
# Tokens are stored in the garmin-tokens Docker volume

set -e

echo "=== Garmin MCP Authentication ==="
echo "This will authenticate with Garmin Connect and save tokens."
echo ""

# Run auth inside the container with the tokens volume mounted
docker run -it --rm \
  -v garmin-mcp_garmin-tokens:/root/.garminconnect \
  --entrypoint "" \
  garmin-mcp-garmin-mcp \
  uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth

echo ""
echo "Authentication complete. Tokens saved to Docker volume."
echo "You can now start the service with: docker compose up -d"
