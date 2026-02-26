FROM node:20-slim

RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Pre-fetch garmin_mcp
RUN uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp --help || true

WORKDIR /app

COPY server.js .
COPY package.json .
RUN npm install

VOLUME ["/root/.garminconnect"]

EXPOSE 8101

CMD ["node", "server.js"]
