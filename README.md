# Garmin + Strava MCP Server

Hosts [Garmin MCP](https://github.com/Taxuspt/garmin_mcp) and [Strava MCP](https://github.com/r-huijts/strava-mcp) as remote MCP servers with OAuth 2.0 authentication, compatible with claude.ai and Claude mobile.

Built by Weiran Xiong with AI support.

## Architecture

```
claude.ai → nginx (garmin.yourdomain.com:443) → server.js (8101) → garmin_mcp (stdio)
claude.ai → nginx (strava.yourdomain.com:443) → strava-server.js (8102) → strava-mcp (stdio)
```

- **server.js** — OAuth 2.0 proxy for Garmin MCP (authorization code + PKCE, client credentials)
- **strava-server.js** — OAuth 2.0 proxy for Strava MCP, includes automatic token refresh
- **nginx** — SSL termination and reverse proxy for both services
- **garmin_mcp** — spawned as a child process via `uvx`
- **strava-mcp** — spawned as a child process via `npx`, tokens refreshed every 6 hours

## Port Allocation

| Port | Service |
|------|---------|
| 8101 | server.js — Garmin (internal) |
| 8102 | strava-server.js — Strava (internal) |
| 443  | nginx (public HTTPS) |

## Prerequisites

- VPS running Ubuntu 24.04
- Docker + Docker Compose
- nginx + certbot (`sudo apt install nginx certbot`)
- Two domains pointing to your VPS IP (e.g. `garmin.yourdomain.com`, `strava.yourdomain.com`)

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/weiranx/garmin-mcp.git
cd garmin-mcp
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Generate strong secrets:
```bash
openssl rand -hex 32  # use for CLIENT_ID
openssl rand -hex 32  # use for CLIENT_SECRET
openssl rand -hex 32  # use for STRAVA_MCP_CLIENT_ID
openssl rand -hex 32  # use for STRAVA_MCP_CLIENT_SECRET
```

`.env` values:
```
# Garmin MCP
CLIENT_ID=your-generated-id
CLIENT_SECRET=your-generated-secret
BASE_URL=https://garmin.yourdomain.com

# Strava MCP OAuth layer
STRAVA_MCP_CLIENT_ID=your-generated-id
STRAVA_MCP_CLIENT_SECRET=your-generated-secret
STRAVA_BASE_URL=https://strava.yourdomain.com

# Strava API credentials (from https://www.strava.com/settings/api)
STRAVA_API_CLIENT_ID=your-strava-app-client-id
STRAVA_API_CLIENT_SECRET=your-strava-app-client-secret
STRAVA_ACCESS_TOKEN=    # filled in by strava-auth.sh
STRAVA_REFRESH_TOKEN=   # filled in by strava-auth.sh
```

### 3. Build Docker image

```bash
docker compose build
```

### 4. Authenticate with Garmin (one-time)

```bash
chmod +x auth.sh
./auth.sh
```

Enter your Garmin email, password, and MFA code when prompted. Tokens are saved to a Docker volume and persist across restarts.

### 5. Authenticate with Strava (one-time)

Create a Strava API app at https://www.strava.com/settings/api. In the app settings, set **Authorization Callback Domain** to `localhost`.

Then run:

```bash
chmod +x strava-auth.sh
./strava-auth.sh
```

The script prints a Strava authorization URL. Open it in your browser, click Authorize, then copy the full URL from the browser's address bar (it will show "This site can't be reached" — that's expected) and paste it back into the terminal. Tokens are saved to a Docker volume and refreshed automatically.

### 6. Start the services

```bash
docker compose up -d
docker compose logs -f
```

Wait for both services to be ready:
```
[garmin] Starting Garmin MCP process...
[server] Listening on port 8101
[strava] Starting Strava MCP process...
[strava-server] Listening on port 8102
```

Test them:
```bash
curl http://localhost:8101/health
# {"status":"ok","garminReady":true}

curl http://localhost:8102/health
# {"status":"ok","stravaReady":true}
```

Both `garminReady` and `stravaReady` must be `true` before proceeding.

### 7. SSL certificates

Stop nginx, issue certificates for both domains, then restart:

```bash
sudo systemctl stop nginx

sudo certbot certonly --standalone -d garmin.yourdomain.com
sudo certbot certonly --standalone -d strava.yourdomain.com

sudo systemctl start nginx
```

Set up auto-renewal hooks so certbot doesn't conflict with nginx:
```bash
sudo nano /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
# add: systemctl stop nginx

sudo nano /etc/letsencrypt/renewal-hooks/post/start-nginx.sh
# add: systemctl start nginx

sudo chmod +x /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/start-nginx.sh

sudo certbot renew --dry-run
```

### 8. Configure nginx

The `setup-nginx.sh` script reads your domain names directly from `.env` and installs both nginx configs:

```bash
chmod +x setup-nginx.sh
./setup-nginx.sh
```

This runs `envsubst` on both `nginx-garmin.conf` and `nginx-strava.conf`, copies them to `/etc/nginx/sites-available/`, enables them, and reloads nginx.

### 9. Add to claude.ai

Settings → Integrations → Add custom connector — add one for each service:

**Garmin:**

| Field | Value |
|---|---|
| Name | Garmin |
| Remote MCP server URL | `https://garmin.yourdomain.com/mcp` |
| OAuth Client ID | your `CLIENT_ID` |
| OAuth Client Secret | your `CLIENT_SECRET` |

**Strava:**

| Field | Value |
|---|---|
| Name | Strava |
| Remote MCP server URL | `https://strava.yourdomain.com/mcp` |
| OAuth Client ID | your `STRAVA_MCP_CLIENT_ID` |
| OAuth Client Secret | your `STRAVA_MCP_CLIENT_SECRET` |

When connecting, a browser window will open asking you to approve access. Click Approve.

## Maintenance

### Re-authenticate Garmin (when tokens expire)

```bash
./auth.sh
docker compose restart garmin-mcp
```

### Re-authenticate Strava (if refresh token is revoked)

```bash
./strava-auth.sh
docker compose restart strava-mcp
```

### View logs

```bash
docker compose logs -f
docker compose logs -f garmin-mcp
docker compose logs -f strava-mcp
```

### Update to latest

```bash
docker compose build --no-cache
docker compose up -d
```

### Stop / restart

```bash
docker compose down
docker compose up -d
```

## Files

| File | Purpose |
|---|---|
| `server.js` | Garmin OAuth proxy + MCP process manager (port 8101) |
| `strava-server.js` | Strava OAuth proxy + MCP process manager (port 8102) |
| `strava-auth-helper.js` | One-time Strava token exchange helper |
| `Dockerfile` | Single container image for both services |
| `docker-compose.yml` | Two-service configuration |
| `nginx-garmin.conf` | nginx template for Garmin (uses `${GARMIN_DOMAIN}`) |
| `nginx-strava.conf` | nginx template for Strava (uses `${STRAVA_DOMAIN}`) |
| `setup-nginx.sh` | Generates nginx configs from `.env` and reloads nginx |
| `auth.sh` | One-time Garmin authentication script |
| `strava-auth.sh` | One-time Strava authentication script |
| `.env.example` | Environment variable template |

## Disclaimer

This project uses the unofficial [garmin_mcp](https://github.com/Taxuspt/garmin_mcp) library which reverse-engineers the Garmin Connect API. It is not affiliated with or endorsed by Garmin. Use at your own risk.
