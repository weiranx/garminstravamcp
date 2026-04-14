#!/bin/bash
set -e

confirm() { read -r -p "  $1 [y/N] " _a; [[ "$_a" =~ ^[yY] ]]; }
ask()     { read -r -p "  $1: " "$2"; }
ask_password() { read -r -s -p "  $1: " "$2"; echo ""; }
gen()     { openssl rand -hex 32; }

# ── Step 1: Install dependencies ──────────────────────────────────────────────

echo ""
echo "=== Step 1: Dependencies ==="
echo ""
if confirm "Install Docker, nginx, and certbot? (skip if already installed)"; then
  sudo apt update && sudo apt upgrade -y
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  sudo apt install -y nginx certbot python3-certbot-nginx

  # Set up certbot renewal hooks so it stops/starts nginx automatically
  sudo bash -c 'echo "systemctl stop nginx" > /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh'
  sudo bash -c 'echo "systemctl start nginx" > /etc/letsencrypt/renewal-hooks/post/start-nginx.sh'
  sudo chmod +x /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
  sudo chmod +x /etc/letsencrypt/renewal-hooks/post/start-nginx.sh

  echo ""
  echo "  Done. NOTE: Log out and back in (or run 'newgrp docker') for Docker group to take effect."
fi

# ── Step 2: Service selection ─────────────────────────────────────────────────

echo ""
echo "=== Step 2: Service selection ==="
echo ""
echo "Which MCP services would you like to enable?"
echo ""

ENABLE_GARMIN=false; ENABLE_STRAVA=false; ENABLE_COROS=false
confirm "Enable Garmin MCP  (port 8101)" && ENABLE_GARMIN=true
confirm "Enable Strava MCP  (port 8102)" && ENABLE_STRAVA=true
confirm "Enable COROS MCP   (port 8103)" && ENABLE_COROS=true

if [ "$ENABLE_GARMIN" = false ] && [ "$ENABLE_STRAVA" = false ] && [ "$ENABLE_COROS" = false ]; then
  echo ""
  echo "No services selected. Exiting."
  exit 0
fi

# ── Step 3: Configure .env ────────────────────────────────────────────────────

echo ""
echo "=== Step 3: Configuration ==="
echo ""

if [ -f .env ]; then
  if confirm ".env already exists. Use existing configuration?"; then
    source .env
  else
    mv .env ".env.bak.$(date +%s)"
    echo "  Old .env backed up."
  fi
fi

if [ ! -f .env ]; then
  echo "  Secrets (CLIENT_ID, CLIENT_SECRET) will be generated automatically."
  echo "  Provide your domain names and API credentials below."
  echo ""

  ENV_CONTENT=""

  if [ "$ENABLE_GARMIN" = true ]; then
    echo "  -- Garmin --"
    ask "Domain (e.g. garmin.yourdomain.com)" GARMIN_HOST
    GARMIN_CLIENT_ID=$(gen)
    GARMIN_CLIENT_SECRET=$(gen)
    ENV_CONTENT="${ENV_CONTENT}
# ── Garmin MCP ────────────────────────────────────────────────────────────────
CLIENT_ID=${GARMIN_CLIENT_ID}
CLIENT_SECRET=${GARMIN_CLIENT_SECRET}
BASE_URL=https://${GARMIN_HOST}
"
    echo ""
  fi

  if [ "$ENABLE_STRAVA" = true ]; then
    echo "  -- Strava --"
    echo "  Get your API credentials at https://www.strava.com/settings/api"
    ask "Domain (e.g. strava.yourdomain.com)" STRAVA_HOST
    ask "Strava API client ID" STRAVA_API_CLIENT_ID
    ask_password "Strava API client secret" STRAVA_API_CLIENT_SECRET
    STRAVA_MCP_CLIENT_ID=$(gen)
    STRAVA_MCP_CLIENT_SECRET=$(gen)
    ENV_CONTENT="${ENV_CONTENT}
# ── Strava MCP ────────────────────────────────────────────────────────────────
STRAVA_MCP_CLIENT_ID=${STRAVA_MCP_CLIENT_ID}
STRAVA_MCP_CLIENT_SECRET=${STRAVA_MCP_CLIENT_SECRET}
STRAVA_BASE_URL=https://${STRAVA_HOST}
STRAVA_API_CLIENT_ID=${STRAVA_API_CLIENT_ID}
STRAVA_API_CLIENT_SECRET=${STRAVA_API_CLIENT_SECRET}
STRAVA_ACCESS_TOKEN=
STRAVA_REFRESH_TOKEN=
"
    echo ""
  fi

  if [ "$ENABLE_COROS" = true ]; then
    echo "  -- COROS --"
    ask "Domain (e.g. coros.yourdomain.com)" COROS_HOST
    ask "COROS account email" COROS_EMAIL
    ask_password "COROS account password" COROS_PASSWORD
    ask "COROS region (eu / us / asia) [eu]" COROS_REGION
    COROS_REGION="${COROS_REGION:-eu}"
    COROS_MCP_CLIENT_ID=$(gen)
    COROS_MCP_CLIENT_SECRET=$(gen)
    ENV_CONTENT="${ENV_CONTENT}
# ── COROS MCP ─────────────────────────────────────────────────────────────────
COROS_MCP_CLIENT_ID=${COROS_MCP_CLIENT_ID}
COROS_MCP_CLIENT_SECRET=${COROS_MCP_CLIENT_SECRET}
COROS_BASE_URL=https://${COROS_HOST}
COROS_EMAIL=${COROS_EMAIL}
COROS_PASSWORD=${COROS_PASSWORD}
COROS_REGION=${COROS_REGION}
"
    echo ""
  fi

  printf '%s\n' "${ENV_CONTENT}" > .env
  echo "  .env written."
  source .env
fi

# ── Step 4: DNS reminder ──────────────────────────────────────────────────────

echo ""
echo "=== Step 4: DNS ==="
echo ""
echo "  Make sure the following DNS A records point to this server's IP ($(curl -sf ifconfig.me 2>/dev/null || echo '<your IP>')):"
echo ""
[ "$ENABLE_GARMIN" = true ] && echo "    ${BASE_URL#https://}"
[ "$ENABLE_STRAVA" = true ] && echo "    ${STRAVA_BASE_URL#https://}"
[ "$ENABLE_COROS"  = true ] && echo "    ${COROS_BASE_URL#https://}"
echo ""
confirm "DNS records are set and propagated — continue?" || { echo "  Re-run setup.sh once DNS is ready."; exit 0; }

# ── Step 5: Build Docker image ────────────────────────────────────────────────

echo ""
echo "=== Step 5: Build ==="
echo ""
docker compose build

# ── Step 6: One-time authentication ──────────────────────────────────────────

echo ""
echo "=== Step 6: Authentication ==="
echo ""

if [ "$ENABLE_GARMIN" = true ]; then
  echo "  Garmin requires interactive authentication."
  if confirm "Run Garmin auth now?"; then
    chmod +x auth.sh
    ./auth.sh
  else
    echo "  Skipping. Run ./auth.sh before starting Garmin."
  fi
  echo ""
fi

if [ "$ENABLE_STRAVA" = true ]; then
  echo "  Strava requires a one-time OAuth flow in your browser."
  if confirm "Run Strava auth now?"; then
    chmod +x strava-auth.sh
    ./strava-auth.sh
    # Reload .env so updated tokens are picked up
    source .env
  else
    echo "  Skipping. Run ./strava-auth.sh before starting Strava."
  fi
  echo ""
fi

# ── Step 7: Start containers ──────────────────────────────────────────────────

echo ""
echo "=== Step 7: Start containers ==="
echo ""

SERVICES="autoheal"
[ "$ENABLE_GARMIN" = true ] && SERVICES="$SERVICES garmin-mcp"
[ "$ENABLE_STRAVA" = true ] && SERVICES="$SERVICES strava-mcp"
[ "$ENABLE_COROS"  = true ] && SERVICES="$SERVICES coros-mcp"

docker compose up -d $SERVICES

echo ""
echo "  Waiting for services to be ready..."
sleep 8

check_health() {
  local name="$1" url="$2" key="$3"
  if curl -sf "$url" 2>/dev/null | grep -q "\"${key}\":true"; then
    echo "  $name: ready"
  else
    echo "  $name: not ready yet — check: docker compose logs $(echo "$name" | tr '[:upper:]' '[:lower:]')-mcp"
  fi
}

[ "$ENABLE_GARMIN" = true ] && check_health "Garmin" "http://localhost:8101/health" "garminReady"
[ "$ENABLE_STRAVA" = true ] && check_health "Strava" "http://localhost:8102/health" "stravaReady"
[ "$ENABLE_COROS"  = true ] && check_health "COROS"  "http://localhost:8103/health" "corosReady"

# ── Step 8: SSL certificates ──────────────────────────────────────────────────

echo ""
echo "=== Step 8: SSL certificates ==="
echo ""

if confirm "Issue SSL certificates with certbot now?"; then
  sudo systemctl stop nginx

  [ "$ENABLE_GARMIN" = true ] && sudo certbot certonly --standalone -d "${BASE_URL#https://}"
  [ "$ENABLE_STRAVA" = true ] && sudo certbot certonly --standalone -d "${STRAVA_BASE_URL#https://}"
  [ "$ENABLE_COROS"  = true ] && sudo certbot certonly --standalone -d "${COROS_BASE_URL#https://}"

  sudo systemctl start nginx
  echo ""
  echo "  Testing auto-renewal..."
  sudo certbot renew --dry-run
else
  echo "  Skipping. Run certbot manually before configuring nginx."
fi

# ── Step 9: Configure nginx ───────────────────────────────────────────────────

echo ""
echo "=== Step 9: nginx ==="
echo ""

if confirm "Configure nginx now?"; then
  export GARMIN_DOMAIN="${BASE_URL#https://}"
  export STRAVA_DOMAIN="${STRAVA_BASE_URL#https://}"
  export COROS_DOMAIN="${COROS_BASE_URL#https://}"

  if [ "$ENABLE_GARMIN" = true ]; then
    envsubst '${GARMIN_DOMAIN}' < nginx-garmin.conf | sudo tee /etc/nginx/sites-available/garmin-mcp > /dev/null
    sudo ln -sf /etc/nginx/sites-available/garmin-mcp /etc/nginx/sites-enabled/garmin-mcp
    echo "  Garmin: configured ($GARMIN_DOMAIN)"
  fi
  if [ "$ENABLE_STRAVA" = true ]; then
    envsubst '${STRAVA_DOMAIN}' < nginx-strava.conf | sudo tee /etc/nginx/sites-available/strava-mcp > /dev/null
    sudo ln -sf /etc/nginx/sites-available/strava-mcp /etc/nginx/sites-enabled/strava-mcp
    echo "  Strava: configured ($STRAVA_DOMAIN)"
  fi
  if [ "$ENABLE_COROS" = true ]; then
    envsubst '${COROS_DOMAIN}' < nginx-coros.conf | sudo tee /etc/nginx/sites-available/coros-mcp > /dev/null
    sudo ln -sf /etc/nginx/sites-available/coros-mcp /etc/nginx/sites-enabled/coros-mcp
    echo "  COROS:  configured ($COROS_DOMAIN)"
  fi

  sudo nginx -t && sudo systemctl reload nginx
fi

# ── Step 10: Summary ──────────────────────────────────────────────────────────

echo ""
echo "=== Done ==="
echo ""
echo "Add to claude.ai: Settings -> Integrations -> Add custom connector"
echo ""

if [ "$ENABLE_GARMIN" = true ]; then
  echo "  Garmin"
  echo "    URL:    ${BASE_URL}/mcp"
  echo "    ID:     ${CLIENT_ID}"
  echo "    Secret: ${CLIENT_SECRET}"
  echo ""
fi
if [ "$ENABLE_STRAVA" = true ]; then
  echo "  Strava"
  echo "    URL:    ${STRAVA_BASE_URL}/mcp"
  echo "    ID:     ${STRAVA_MCP_CLIENT_ID}"
  echo "    Secret: ${STRAVA_MCP_CLIENT_SECRET}"
  echo ""
fi
if [ "$ENABLE_COROS" = true ]; then
  echo "  COROS"
  echo "    URL:    ${COROS_BASE_URL}/mcp"
  echo "    ID:     ${COROS_MCP_CLIENT_ID}"
  echo "    Secret: ${COROS_MCP_CLIENT_SECRET}"
  echo ""
fi
