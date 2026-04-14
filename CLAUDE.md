# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Hosts Garmin and Strava MCP servers as remote HTTP servers with OAuth 2.0 authentication, so claude.ai and Claude mobile can connect to them via custom integrations. Each service runs as a Docker container behind nginx with SSL.

## Architecture

```
claude.ai → nginx (garmin.yourdomain.com:443) → server.js (8101) → garmin_mcp subprocess (uvx, stdio)
claude.ai → nginx (strava.yourdomain.com:443) → strava-server.js (8102) → strava-mcp subprocess (npx, stdio)
claude.ai → nginx (coros.yourdomain.com:443) → coros-server.js (8103) → coros-mcp subprocess (uvx, stdio)
```

**Three independent Node.js servers**, each following the same pattern:
1. Spawns the upstream MCP tool as a child process communicating over stdio (line-delimited JSON-RPC)
2. Implements OAuth 2.0 (authorization code + PKCE, and client credentials) so claude.ai can authenticate
3. Proxies authenticated POST `/mcp` requests to the child process and returns its response
4. Persists OAuth tokens issued to claude.ai to a Docker volume so they survive restarts

**Key design constraint**: The `initialize` MCP method is handled directly by the Node server (not forwarded to the child process) so that claude.ai never sees a 503 during startup. A 503 on `initialize` causes claude.ai to permanently disconnect the integration.

**COROS-specific**: `coros-server.js` passes `COROS_EMAIL`, `COROS_PASSWORD`, and `COROS_REGION` directly to the child process environment. The coros-mcp library authenticates with the COROS API automatically on first use and re-authenticates when the token expires — no separate auth script is needed.

**Strava-specific**: `strava-server.js` also manages Strava API token refresh — it calls the Strava OAuth endpoint to refresh the access token before starting the child process and every 5.5 hours (Strava tokens expire after 6 hours). The Strava config is stored at `/root/.config/strava-mcp/config.json` in the container.

**Three separate Docker volumes** keep the credential stores separate:
- `garmin-tokens` → `/root/.garminconnect` (Garmin session tokens + MCP OAuth tokens)
- `strava-tokens` → `/root/.config/strava-mcp` (Strava API tokens + MCP OAuth tokens)
- `coros-tokens` → `/root/.config/coros-mcp` (COROS auth token + MCP OAuth tokens)

## Environment variables

The `.env.example` file documents all required variables. The `strava-mcp` container uses different env var names from `garmin-mcp`:

| Container | CLIENT_ID | CLIENT_SECRET | BASE_URL |
|---|---|---|---|
| garmin-mcp | `CLIENT_ID` | `CLIENT_SECRET` | `BASE_URL` |
| strava-mcp | `STRAVA_MCP_CLIENT_ID` | `STRAVA_MCP_CLIENT_SECRET` | `STRAVA_BASE_URL` |
| coros-mcp | `COROS_MCP_CLIENT_ID` | `COROS_MCP_CLIENT_SECRET` | `COROS_BASE_URL` |

COROS also requires `COROS_EMAIL`, `COROS_PASSWORD`, and `COROS_REGION` (`eu`, `us`, or `asia`).

`docker-compose.yml` remaps these into the container's `CLIENT_ID`/`CLIENT_SECRET`/`BASE_URL` env vars, which is what both server files read.

## Common operations

```bash
# Build and start
docker compose build
docker compose up -d
docker compose logs -f

# Health checks
curl http://localhost:8101/health   # {"status":"ok","garminReady":true}
curl http://localhost:8102/health   # {"status":"ok","stravaReady":true}
curl http://localhost:8103/health   # {"status":"ok","corosReady":true}

# Re-authenticate Garmin (session tokens expired)
./auth.sh && docker compose restart garmin-mcp

# Re-authenticate Strava (refresh token revoked)
./strava-auth.sh && docker compose restart strava-mcp

# Update to latest
git pull && docker compose build --no-cache && docker compose up -d

# Check persisted MCP OAuth tokens
docker exec garmin-mcp cat /root/.garminconnect/oauth-tokens.json
docker exec strava-mcp cat /root/.config/strava-mcp/oauth-tokens.json

# Verify tokens were loaded on startup
docker logs garmin-mcp 2>&1 | grep "persisted token"
docker logs strava-mcp 2>&1 | grep "persisted token"
```

## nginx

Two template files (`nginx-garmin.conf`, `nginx-strava.conf`) use `${GARMIN_DOMAIN}` and `${STRAVA_DOMAIN}` placeholders. `setup-nginx.sh` runs `envsubst` on them using values from `.env`, writes configs to `/etc/nginx/sites-available/`, and reloads nginx. nginx handles SSL termination; the Node servers run on plain HTTP internally.
