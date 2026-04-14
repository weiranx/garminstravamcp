FROM node:20-slim

RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv (for Garmin MCP)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Pre-cache Garmin MCP
RUN uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp --help || true

# Pre-cache Strava MCP
RUN npx --yes @r-huijts/strava-mcp-server --help 2>/dev/null || true

# Pre-cache COROS MCP
RUN uvx --python 3.12 --from git+https://github.com/cygnusb/coros-mcp coros-mcp --help 2>/dev/null || true

WORKDIR /app

COPY server.js strava-server.js coros-server.js strava-auth-helper.js package.json ./
RUN npm install

VOLUME ["/root/.garminconnect"]
VOLUME ["/root/.config/strava-mcp"]

EXPOSE 8101 8102

CMD ["node", "server.js"]
