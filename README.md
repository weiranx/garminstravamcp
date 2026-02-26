# Garmin MCP Server

Hosts the [Garmin MCP](https://github.com/Taxuspt/garmin_mcp) as a remote MCP server with OAuth 2.0 authentication, compatible with claude.ai and Claude mobile.

Built by Weiran Xiong with AI support.

## Architecture

```
claude.ai → nginx (443/SSL) → server.js (8101) → garmin_mcp (stdio)
```

- **server.js** — Express app that manages the Garmin MCP stdio process directly, handles OAuth 2.0 (authorization code + PKCE, client credentials), and proxies MCP requests
- **nginx** — SSL termination, reverse proxy
- **garmin_mcp** — spawned as a child process, communicates over stdin/stdout

## OAuth Flow

claude.ai uses the full OAuth 2.0 authorization code flow with PKCE:

1. claude.ai redirects to `/authorize` — a consent page appears in your browser
2. You click Approve
3. claude.ai exchanges the code for a bearer token at `/oauth/token`
4. All `/mcp` requests are authenticated with the bearer token

## Port Allocation

| Port | Service |
|------|---------|
| 8101 | server.js (internal) |
| 443  | nginx (public HTTPS) |

Port 80 is intentionally left free.

## Prerequisites

- VPS running Ubuntu 24.04
- Docker + Docker Compose
- nginx + certbot
- Domain pointing to your VPS IP

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
```

`.env` values:
```
CLIENT_ID=your-generated-id
CLIENT_SECRET=your-generated-secret
BASE_URL=https://garmin.yourdomain.com
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

### 5. Start the service

```bash
docker compose up -d
docker compose logs -f
```

Wait for:
```
[garmin] Starting Garmin MCP process...
[server] Listening on port 8101
```

Test it:
```bash
curl http://localhost:8101/health
# {"status":"ok","garminReady":true}
```

`garminReady` must be `true` before proceeding.

### 6. SSL certificate

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d garmin.yourdomain.com
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

### 7. Configure nginx

```bash
sudo cp nginx-garmin.conf /etc/nginx/sites-available/garmin-mcp
sudo nano /etc/nginx/sites-available/garmin-mcp  # update domain name
sudo ln -s /etc/nginx/sites-available/garmin-mcp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. Add to claude.ai

Settings → Integrations → Add custom connector:

| Field | Value |
|---|---|
| Name | Garmin |
| Remote MCP server URL | `https://garmin.yourdomain.com/mcp` |
| OAuth Client ID | your CLIENT_ID |
| OAuth Client Secret | your CLIENT_SECRET |

When connecting, a browser window will open asking you to approve access. Click Approve.

## Maintenance

### Re-authenticate Garmin (when tokens expire)

```bash
./auth.sh
docker compose restart
```

### View logs

```bash
docker compose logs -f
```

### Update garmin_mcp to latest

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
| `server.js` | Main server — OAuth + MCP proxy + Garmin process manager |
| `Dockerfile` | Container definition |
| `docker-compose.yml` | Service configuration |
| `nginx-garmin.conf` | nginx config template |
| `auth.sh` | One-time Garmin authentication script |
| `.env.example` | Environment variable template |

## Disclaimer

This project uses the unofficial [garmin_mcp](https://github.com/Taxuspt/garmin_mcp) library which reverse-engineers the Garmin Connect API. It is not affiliated with or endorsed by Garmin. Use at your own risk.
