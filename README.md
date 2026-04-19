# Garmin + Strava + COROS MCP Server

Hosts [Garmin MCP](https://github.com/Taxuspt/garmin_mcp), [Strava MCP](https://github.com/r-huijts/strava-mcp), and [COROS MCP](https://github.com/wrnrlr/coros-mcp) as remote MCP servers with OAuth 2.0 authentication, compatible with claude.ai and Claude mobile.

## Architecture

```
claude.ai → nginx (garmin.yourdomain.com:443) → server.js (8101)        → garmin_mcp (stdio)
claude.ai → nginx (strava.yourdomain.com:443) → strava-server.js (8102) → strava-mcp (stdio)
claude.ai → nginx (coros.yourdomain.com:443)  → coros-server.js (8103)  → coros-mcp  (stdio)
```

- **server.js** — OAuth 2.0 proxy for Garmin MCP (authorization code + PKCE, client credentials)
- **strava-server.js** — OAuth 2.0 proxy for Strava MCP, includes automatic token refresh
- **coros-server.js** — OAuth 2.0 proxy for COROS MCP
- **nginx** — SSL termination and reverse proxy for all services
- **garmin_mcp** — spawned as a child process via `uvx`
- **strava-mcp** — spawned as a child process via `npx`, tokens refreshed every 6 hours
- **coros-mcp** — spawned as a child process via `uvx`; authenticates with the COROS API automatically on first use and re-authenticates when the token expires

## Port Allocation

| Port | Service |
|------|---------|
| 8101 | server.js — Garmin (internal) |
| 8102 | strava-server.js — Strava (internal) |
| 8103 | coros-server.js — COROS (internal) |
| 443  | nginx (public HTTPS) |

## Prerequisites

- VPS running Ubuntu 24.04
- A domain name with DNS you can configure (e.g. Cloudflare, Namecheap, Route53)
- Docker + Docker Compose
- nginx + certbot (`sudo apt install nginx certbot python3-certbot-nginx`)

## Setup

### 1. Provision your VPS

SSH into your VPS and install dependencies:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Install nginx and certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Verify
docker --version
nginx -v
```

Open the firewall for HTTP and HTTPS (needed for Let's Encrypt and for claude.ai):

```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow OpenSSH
sudo ufw enable
```

### 2. Point your domains at the VPS

You need one subdomain per service you plan to enable. Create **A records** in your DNS provider's dashboard:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `garmin` | `<your VPS IP>` | 300 |
| A | `strava` | `<your VPS IP>` | 300 |
| A | `coros`  | `<your VPS IP>` | 300 |

This makes `garmin.yourdomain.com`, `strava.yourdomain.com`, and `coros.yourdomain.com` resolve to your VPS.

**Find your VPS IP:**
```bash
curl ifconfig.me
```

**Verify DNS has propagated** before continuing (can take a few minutes):
```bash
dig garmin.yourdomain.com +short
dig strava.yourdomain.com +short
dig coros.yourdomain.com +short
# All should return your VPS IP
```

You can also check propagation from outside your network at https://dnschecker.org.

### 3. Clone the repo

```bash
git clone https://github.com/weiranx/garminstravamcp.git
cd garminmcp
```

### 4. Configure environment

```bash
cp .env.example .env
nano .env
```

Generate strong secrets (one pair per service you're enabling):
```bash
openssl rand -hex 32  # use for CLIENT_ID / CLIENT_SECRET (Garmin)
openssl rand -hex 32  # use for STRAVA_MCP_CLIENT_ID / STRAVA_MCP_CLIENT_SECRET
openssl rand -hex 32  # use for COROS_MCP_CLIENT_ID / COROS_MCP_CLIENT_SECRET
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

# COROS MCP OAuth layer
COROS_MCP_CLIENT_ID=your-generated-id
COROS_MCP_CLIENT_SECRET=your-generated-secret
COROS_BASE_URL=https://coros.yourdomain.com

# COROS account credentials
COROS_EMAIL=you@example.com
COROS_PASSWORD=your-coros-password
COROS_REGION=eu    # eu, us, or asia
```

Alternatively, run `./setup.sh` — it walks through dependency install, env generation, DNS reminder, build, auth, SSL, and nginx in one flow, and can be re-run later to add an additional service without disturbing the ones already configured.

### 5. Build Docker image

```bash
docker compose build
```

### 6. Authenticate with Garmin (one-time)

```bash
chmod +x auth.sh
./auth.sh
```

Enter your Garmin email, password, and MFA code when prompted. Tokens are saved to a Docker volume and persist across restarts.

### 7. Authenticate with Strava (one-time)

Create a Strava API app at https://www.strava.com/settings/api. In the app settings, set **Authorization Callback Domain** to `localhost`.

Then run:

```bash
chmod +x strava-auth.sh
./strava-auth.sh
```

The script prints a Strava authorization URL. Open it in your browser, click Authorize, then copy the full URL from the browser's address bar (it will show "This site can't be reached" — that's expected) and paste it back into the terminal. Tokens are saved to a Docker volume and refreshed automatically every 5.5 hours.

### 7b. COROS (no manual auth needed)

COROS authenticates automatically on first use using `COROS_EMAIL` / `COROS_PASSWORD` / `COROS_REGION` from `.env`. The `coros-mcp` library re-authenticates when the token expires — no separate auth script to run.

### 8. Start the services

```bash
docker compose up -d
docker compose logs -f
```

This starts up to four containers: `garmin-mcp`, `strava-mcp`, `coros-mcp`, and `autoheal`. The `autoheal` container watches the MCP services and restarts any that become `unhealthy` (i.e. fail their healthcheck). It checks every 10 seconds after a 30-second startup grace period.

Wait for services to be ready:
```
[garmin] Starting Garmin MCP process...
[server] Listening on port 8101
[strava] Starting Strava MCP process...
[strava-server] Listening on port 8102
[coros] Starting COROS MCP process...
[coros-server] Listening on port 8103
```

Test them:
```bash
curl http://localhost:8101/health
# {"status":"ok","garminReady":true}

curl http://localhost:8102/health
# {"status":"ok","stravaReady":true}

curl http://localhost:8103/health
# {"status":"ok","corosReady":true}
```

The `*Ready` flag for each enabled service must be `true` before proceeding.

### 9. SSL certificates

Issue certificates for both domains using certbot's standalone mode (temporarily stops nginx):

```bash
sudo systemctl stop nginx

sudo certbot certonly --standalone -d garmin.yourdomain.com
sudo certbot certonly --standalone -d strava.yourdomain.com
sudo certbot certonly --standalone -d coros.yourdomain.com

sudo systemctl start nginx
```

Set up auto-renewal hooks so certbot doesn't conflict with nginx:
```bash
sudo bash -c 'echo "systemctl stop nginx" > /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh'
sudo bash -c 'echo "systemctl start nginx" > /etc/letsencrypt/renewal-hooks/post/start-nginx.sh'
sudo chmod +x /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/start-nginx.sh

# Test renewal
sudo certbot renew --dry-run
```

### 10. Configure nginx

The `setup-nginx.sh` script reads your domain names directly from `.env` and installs the nginx configs:

```bash
chmod +x setup-nginx.sh
./setup-nginx.sh
```

This runs `envsubst` on `nginx-garmin.conf`, `nginx-strava.conf`, and `nginx-coros.conf`, copies them to `/etc/nginx/sites-available/`, enables them, and reloads nginx.

Verify nginx is working:
```bash
sudo nginx -t
curl https://garmin.yourdomain.com/health
# {"status":"ok","garminReady":true}

curl https://strava.yourdomain.com/health
# {"status":"ok","stravaReady":true}

curl https://coros.yourdomain.com/health
# {"status":"ok","corosReady":true}
```

### 11. Add to claude.ai

Go to **Settings → Integrations → Add custom connector** and add one entry for each service:

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

**COROS:**

| Field | Value |
|---|---|
| Name | COROS |
| Remote MCP server URL | `https://coros.yourdomain.com/mcp` |
| OAuth Client ID | your `COROS_MCP_CLIENT_ID` |
| OAuth Client Secret | your `COROS_MCP_CLIENT_SECRET` |

When connecting, a browser window will open asking you to approve access. Click **Approve**.

OAuth tokens issued to claude.ai never expire and are persisted to disk, so you will not need to reconnect after restarting the containers.

## Maintenance

### Restart containers

```bash
docker compose restart

# Or full stop/start:
docker compose down
docker compose up -d
```

### Restart behavior summary

| Failure | What happens |
|---|---|
| Child process (`garmin_mcp` / `strava-mcp`) crashes | Node restarts it automatically after 3 s |
| Node (`server.js`) crashes / exits | Docker restarts the container (`restart: unless-stopped`) |
| Healthcheck fails 3× (Node hung) | `autoheal` restarts the container within ~30 s |
| VPS reboots | Docker starts containers on boot automatically |

### Re-authenticate Garmin (when Garmin session tokens expire)

```bash
./auth.sh
docker compose restart garmin-mcp
```

### Re-authenticate Strava (if refresh token is revoked)

```bash
./strava-auth.sh
docker compose restart strava-mcp
```

### Re-authenticate COROS (if credentials change)

Edit `COROS_EMAIL` / `COROS_PASSWORD` in `.env`, then:

```bash
docker compose restart coros-mcp
```

The COROS library will re-authenticate on next use.

### View logs

```bash
docker compose logs -f
docker compose logs -f garmin-mcp
docker compose logs -f strava-mcp
docker compose logs -f coros-mcp
```

### Check persisted OAuth tokens

```bash
# Garmin
docker exec garmin-mcp cat /root/.garminconnect/oauth-tokens.json

# Strava
docker exec strava-mcp cat /root/.config/strava-mcp/oauth-tokens.json

# COROS
docker exec coros-mcp cat /root/.config/coros-mcp/oauth-tokens.json
```

You should see a JSON array of token strings. If the file is missing, reconnect the MCP in claude.ai to issue a new token.

Verify tokens are loaded on startup:
```bash
docker logs garmin-mcp 2>&1 | grep "persisted token"
docker logs strava-mcp 2>&1 | grep "persisted token"
docker logs coros-mcp  2>&1 | grep "persisted token"
# Loaded N persisted token(s)
```

### Update to latest

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

## Files

| File | Purpose |
|---|---|
| `server.js` | Garmin OAuth proxy + MCP process manager (port 8101) |
| `strava-server.js` | Strava OAuth proxy + MCP process manager (port 8102) |
| `coros-server.js` | COROS OAuth proxy + MCP process manager (port 8103) |
| `strava-auth-helper.js` | One-time Strava token exchange helper |
| `Dockerfile` | Single container image used by all services |
| `docker-compose.yml` | Multi-service configuration |
| `nginx-garmin.conf` | nginx template for Garmin (uses `${GARMIN_DOMAIN}`) |
| `nginx-strava.conf` | nginx template for Strava (uses `${STRAVA_DOMAIN}`) |
| `nginx-coros.conf`  | nginx template for COROS (uses `${COROS_DOMAIN}`) |
| `setup.sh` | End-to-end installer; re-run to add a service without disturbing existing ones |
| `setup-nginx.sh` | Generates nginx configs from `.env` and reloads nginx |
| `auth.sh` | One-time Garmin authentication script |
| `strava-auth.sh` | One-time Strava authentication script |
| `.env.example` | Environment variable template |

## Disclaimer

This project uses the unofficial [garmin_mcp](https://github.com/Taxuspt/garmin_mcp) and [coros-mcp](https://github.com/wrnrlr/coros-mcp) libraries, which reverse-engineer the Garmin Connect and COROS APIs respectively. It is not affiliated with or endorsed by Garmin, Strava, or COROS. Use at your own risk.
