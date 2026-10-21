#!/bin/bash
set -e

if [ ! -f .env ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

source .env

if [ -z "$BASE_URL" ] || [ -z "$STRAVA_BASE_URL" ] || [ -z "$COROS_BASE_URL" ]; then
  echo "Error: BASE_URL, STRAVA_BASE_URL, and COROS_BASE_URL must be set in .env"
  exit 1
fi

export GARMIN_DOMAIN="${BASE_URL#https://}"
export STRAVA_DOMAIN="${STRAVA_BASE_URL#https://}"
export COROS_DOMAIN="${COROS_BASE_URL#https://}"

echo "Configuring nginx for:"
echo "  Garmin: $GARMIN_DOMAIN"
echo "  Strava: $STRAVA_DOMAIN"
echo "  COROS:  $COROS_DOMAIN"
[ -n "$GPX_BASE_URL" ] && echo "  GPX:    ${GPX_BASE_URL#https://}"

envsubst '${GARMIN_DOMAIN}' < nginx-garmin.conf | sudo tee /etc/nginx/sites-available/garmin-mcp > /dev/null
envsubst '${STRAVA_DOMAIN}' < nginx-strava.conf | sudo tee /etc/nginx/sites-available/strava-mcp > /dev/null
envsubst '${COROS_DOMAIN}' < nginx-coros.conf | sudo tee /etc/nginx/sites-available/coros-mcp > /dev/null

sudo ln -sf /etc/nginx/sites-available/garmin-mcp /etc/nginx/sites-enabled/garmin-mcp
sudo ln -sf /etc/nginx/sites-available/strava-mcp /etc/nginx/sites-enabled/strava-mcp
sudo ln -sf /etc/nginx/sites-available/coros-mcp /etc/nginx/sites-enabled/coros-mcp

# gpx-stitch is optional: only configured when GPX_BASE_URL is set
if [ -n "$GPX_BASE_URL" ]; then
  export GPX_DOMAIN="${GPX_BASE_URL#https://}"
  envsubst '${GPX_DOMAIN}' < nginx-gpx.conf | sudo tee /etc/nginx/sites-available/gpx-mcp > /dev/null
  sudo ln -sf /etc/nginx/sites-available/gpx-mcp /etc/nginx/sites-enabled/gpx-mcp
fi

sudo nginx -t && sudo systemctl reload nginx

echo "Done. Nginx configured for $GARMIN_DOMAIN, $STRAVA_DOMAIN, and $COROS_DOMAIN"
