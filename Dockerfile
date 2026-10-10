# syntax=docker/dockerfile:1.7
# Planner: one container serving the API, the webhooks, and the built web UI.
ARG NODE_VERSION=22.23.3

# ---- build: compile web + server ------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Toolchain only in case a native module has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/canvas/package.json packages/canvas/
COPY packages/mcp-canvas/package.json packages/mcp-canvas/
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_APP_TIMEZONE=America/New_York
RUN npm run build -w @planner/web && npm run build -w @planner/server

# ---- deps: production dependencies of the server only ---------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/canvas/package.json packages/canvas/
COPY packages/mcp-canvas/package.json packages/mcp-canvas/
RUN npm ci --omit=dev --no-audit --no-fund -w @planner/server && mkdir -p apps/server/node_modules

# ---- runtime ---------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG LITESTREAM_VERSION=0.5.17
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/litestream.deb \
    "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.deb" \
 && dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/planner.db \
    TOKEN_STORE=file \
    TOKEN_FILE_PATH=/data/tokens.enc.json \
    WEB_DIST_DIR=/app/apps/web/dist \
    TRUST_PROXY=true

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY deploy/litestream.yml /etc/litestream.yml
COPY --chmod=0755 deploy/entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Starts as root only to fix volume ownership, then drops to the unprivileged `node` user.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
