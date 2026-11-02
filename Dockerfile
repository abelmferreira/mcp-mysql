# syntax=docker/dockerfile:1

# Node major used by every stage. Must satisfy "engines" in package.json.
ARG NODE_VERSION=22

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# Install all dependencies (including dev) exactly as pinned in the lockfile.
# --ignore-scripts: the "prepare" script runs `npm run build`, but the sources
# are not copied yet, so we build explicitly below. It also skips the optional
# native addon of ssh2 (cpu-features), which ssh2 does not require.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

# Compile TypeScript -> build/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Test stage (docker build --target test .) ----------
FROM builder AS test
COPY vitest.config.ts ./
COPY tests ./tests
RUN npm test

# ---------- Production dependencies ----------
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---------- Runtime stage ----------
FROM node:${NODE_VERSION}-alpine AS runtime

# OCI metadata. In CI docker/metadata-action sets these labels too (and wins);
# the build args let local builds fill them in as well.
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/abelmferreira/mcp-mysql
LABEL org.opencontainers.image.title="mcp-mysql" \
      org.opencontainers.image.description="MCP server for MySQL/MariaDB - query, monitor and analyze" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.url="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="abelmferreira"

ENV NODE_ENV=production
WORKDIR /app

# Files stay owned by root (read-only for the runtime user), so the process
# cannot modify its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY package.json ./

# Run as the unprivileged "node" user (uid/gid 1000) shipped with the image.
# NOTE: a private key mounted read-only (e.g. -v ~/.ssh/key:/run/secrets/ssh_key:ro)
# must be readable by uid 1000. If the host file is 0600 and owned by another
# uid, run with `--user "$(id -u):$(id -g)"` or adjust ownership on the host.
USER node

# MCP servers communicate over stdio (run with `docker run -i`).
ENTRYPOINT ["node", "build/index.js"]
