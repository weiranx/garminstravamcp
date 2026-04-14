#!/bin/bash
set -e

if [ ! -f .env ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

source .env

# ── Service selection ─────────────────────────────────────────────────────────

echo ""
echo "Which MCP services would you like to enable?"
echo ""

ask() {
  local prompt="$1"
  local var="$2"
  read -r -p "  Enable $prompt? [y/N] " answer
  case "$answer" in
    [yY][eE][sS]|[yY]) eval "$var=true" ;;
    *) eval "$var=false" ;;
  esac
}

ask "Garmin MCP  (port 8101)" ENABLE_GARMIN
ask "Strava MCP  (port 8102)" ENABLE_STRAVA
ask "COROS MCP   (port 8103)" ENABLE_COROS

echo ""

if [ "$ENABLE_GARMIN" = false ] && [ "$ENABLE_STRAVA" = false ] && [ "$ENABLE_COROS" = false ]; then
  echo "No services selected. Exiting."
  exit 0
fi

# ── Validate required env vars ────────────────────────────────────────────────

errors=0

if [ "$ENABLE_GARMIN" = true ]; then
  if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ] || [ -z "$BASE_URL" ]; then
    echo "Error: CLIENT_ID, CLIENT_SECRET, and BASE_URL must be set in .env for Garmin."
    errors=$((errors + 1))
  fi
fi

if [ "$ENABLE_STRAVA" = true ]; then
  if [ -z "$STRAVA_MCP_CLIENT_ID" ] || [ -z "$STRAVA_MCP_CLIENT_SECRET" ] || [ -z "$STRAVA_BASE_URL" ]; then
    echo "Error: STRAVA_MCP_CLIENT_ID, STRAVA_MCP_CLIENT_SECRET, and STRAVA_BASE_URL must be set in .env for Strava."
    errors=$((errors + 1))
  fi
  if [ -z "$STRAVA_API_CLIENT_ID" ] || [ -z "$STRAVA_API_CLIENT_SECRET" ]; then
    echo "Error: STRAVA_API_CLIENT_ID and STRAVA_API_CLIENT_SECRET must be set in .env for Strava."
    errors=$((errors + 1))
  fi
fi

if [ "$ENABLE_COROS" = true ]; then
  if [ -z "$COROS_MCP_CLIENT_ID" ] || [ -z "$COROS_MCP_CLIENT_SECRET" ] || [ -z "$COROS_BASE_URL" ]; then
    echo "Error: COROS_MCP_CLIENT_ID, COROS_MCP_CLIENT_SECRET, and COROS_BASE_URL must be set in .env for COROS."
    errors=$((errors + 1))
  fi
  if [ -z "$COROS_EMAIL" ] || [ -z "$COROS_PASSWORD" ]; then
    echo "Error: COROS_EMAIL and COROS_PASSWORD must be set in .env for COROS."
    errors=$((errors + 1))
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi

# ── Build image ───────────────────────────────────────────────────────────────

echo "Building Docker image..."
docker compose build

# ── One-time authentication ───────────────────────────────────────────────────

if [ "$ENABLE_GARMIN" = true ]; then
  echo ""
  echo "Garmin requires one-time authentication."
  read -r -p "  Run Garmin auth now? [y/N] " answer
  if [[ "$answer" =~ ^[yY] ]]; then
    chmod +x auth.sh
    ./auth.sh
  else
    echo "  Skipping. Run ./auth.sh before starting Garmin."
  fi
fi

if [ "$ENABLE_STRAVA" = true ]; then
  echo ""
  echo "Strava requires one-time authentication."
  read -r -p "  Run Strava auth now? [y/N] " answer
  if [[ "$answer" =~ ^[yY] ]]; then
    chmod +x strava-auth.sh
    ./strava-auth.sh
  else
    echo "  Skipping. Run ./strava-auth.sh before starting Strava."
  fi
fi

# ── Start containers ──────────────────────────────────────────────────────────

SERVICES="autoheal"
[ "$ENABLE_GARMIN" = true ] && SERVICES="$SERVICES garmin-mcp"
[ "$ENABLE_STRAVA" = true ] && SERVICES="$SERVICES strava-mcp"
[ "$ENABLE_COROS"  = true ] && SERVICES="$SERVICES coros-mcp"

echo ""
echo "Starting: $SERVICES"
docker compose up -d $SERVICES

echo ""
echo "Waiting for services to be ready..."
sleep 5

[ "$ENABLE_GARMIN" = true ] && curl -sf http://localhost:8101/health | grep -q '"garminReady":true' \
  && echo "  Garmin: ready" || echo "  Garmin: not ready yet (check: docker compose logs garmin-mcp)"

[ "$ENABLE_STRAVA" = true ] && curl -sf http://localhost:8102/health | grep -q '"stravaReady":true' \
  && echo "  Strava: ready" || echo "  Strava: not ready yet (check: docker compose logs strava-mcp)"

[ "$ENABLE_COROS"  = true ] && curl -sf http://localhost:8103/health | grep -q '"corosReady":true' \
  && echo "  COROS:  ready" || echo "  COROS:  not ready yet (check: docker compose logs coros-mcp)"

# ── nginx ─────────────────────────────────────────────────────────────────────

echo ""
read -r -p "Configure nginx now? [y/N] " answer
if [[ "$answer" =~ ^[yY] ]]; then
  export GARMIN_DOMAIN="${BASE_URL#https://}"
  export STRAVA_DOMAIN="${STRAVA_BASE_URL#https://}"
  export COROS_DOMAIN="${COROS_BASE_URL#https://}"

  if [ "$ENABLE_GARMIN" = true ]; then
    envsubst '${GARMIN_DOMAIN}' < nginx-garmin.conf | sudo tee /etc/nginx/sites-available/garmin-mcp > /dev/null
    sudo ln -sf /etc/nginx/sites-available/garmin-mcp /etc/nginx/sites-enabled/garmin-mcp
    echo "  Garmin nginx: configured ($GARMIN_DOMAIN)"
  fi

  if [ "$ENABLE_STRAVA" = true ]; then
    envsubst '${STRAVA_DOMAIN}' < nginx-strava.conf | sudo tee /etc/nginx/sites-available/strava-mcp > /dev/null
    sudo ln -sf /etc/nginx/sites-available/strava-mcp /etc/nginx/sites-enabled/strava-mcp
    echo "  Strava nginx: configured ($STRAVA_DOMAIN)"
  fi

  if [ "$ENABLE_COROS" = true ]; then
    envsubst '${COROS_DOMAIN}' < nginx-coros.conf | sudo tee /etc/nginx/sites-available/coros-mcp > /dev/null
    sudo ln -sf /etc/nginx/sites-available/coros-mcp /etc/nginx/sites-enabled/coros-mcp
    echo "  COROS nginx:  configured ($COROS_DOMAIN)"
  fi

  sudo nginx -t && sudo systemctl reload nginx
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Done. Add to claude.ai (Settings → Integrations → Add custom connector):"
echo ""

if [ "$ENABLE_GARMIN" = true ]; then
  echo "  Garmin"
  echo "    URL:    $BASE_URL/mcp"
  echo "    ID:     $CLIENT_ID"
  echo "    Secret: $CLIENT_SECRET"
  echo ""
fi

if [ "$ENABLE_STRAVA" = true ]; then
  echo "  Strava"
  echo "    URL:    $STRAVA_BASE_URL/mcp"
  echo "    ID:     $STRAVA_MCP_CLIENT_ID"
  echo "    Secret: $STRAVA_MCP_CLIENT_SECRET"
  echo ""
fi

if [ "$ENABLE_COROS" = true ]; then
  echo "  COROS"
  echo "    URL:    $COROS_BASE_URL/mcp"
  echo "    ID:     $COROS_MCP_CLIENT_ID"
  echo "    Secret: $COROS_MCP_CLIENT_SECRET"
  echo ""
fi
