# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# ---- build: TypeScript -> JavaScript -----------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- production dependencies --------------------------------------------------
# better-sqlite3 ships prebuilt binaries for musl on amd64 and arm64, so no
# compiler is needed here or in the image that ships (.npmrc skips the
# install scripts that would try to build it anyway).
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/steward.db

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/generate-token.mjs ./scripts/generate-token.mjs

# The image's built-in "node" user (uid 1000). /data must be writable by it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

# Readiness, not just liveness: the container reports unhealthy while the
# Discord connection is down, so `docker ps` shows the problem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/readyz || exit 1

# Node is PID 1 and handles SIGTERM itself: it stops taking requests, lets a
# running blueprint apply reach a step boundary, then closes the gateway and DB.
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
