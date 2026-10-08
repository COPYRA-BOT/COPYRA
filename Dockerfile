# syntax=docker/dockerfile:1.7
# COPYRA production image for DigitalOcean App Platform.
# Build context MUST be the repository root.
#
# Speed model (BuildKit stage cache):
#  * deps        — cached until package-lock / package.json change
#  * build-backend — rebuilds only when packages/api/worker/scripts change
#  * build-web   — rebuilds only when apps/web (or lockfile) change
# Changing only API/worker no longer rebundles the Reown/Vite wallet app.

FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV DATABASE_URL=${DATABASE_URL}

# Public Reown project id — bake into Vite when DO sets RUN_AND_BUILD_TIME.
ARG VITE_REOWN_PROJECT_ID=
ENV VITE_REOWN_PROJECT_ID=${VITE_REOWN_PROJECT_ID}

# ----------------------------------------------------------------------------
# deps — npm ci only (heaviest layer; keep invalidation rare)
# ----------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund

# ----------------------------------------------------------------------------
# build-backend — db / core / api / worker (no Vite)
# ----------------------------------------------------------------------------
FROM deps AS build-backend

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY scripts ./scripts

RUN npm run db:generate \
  && npm run build -w @copyra/db \
  && npm run build -w @copyra/core \
  && npm run build -w @copyra/api \
  && npm run build -w @copyra/worker

# ----------------------------------------------------------------------------
# build-web — Vite / Reown only; independent cache from backend
# ----------------------------------------------------------------------------
FROM deps AS build-web

COPY tsconfig.base.json tsconfig.json ./
COPY apps/web ./apps/web

RUN --mount=type=cache,target=/app/node_modules/.vite \
  --mount=type=cache,target=/app/apps/web/node_modules/.vite \
  npm run build -w @copyra/web \
  && rm -f /app/apps/web/dist/config.js

# ----------------------------------------------------------------------------
# prune — production node_modules + assembled app (smaller image push)
# ----------------------------------------------------------------------------
FROM build-backend AS assemble

COPY --from=build-web /app/apps/web/dist ./apps/web/dist
COPY --from=build-web /app/apps/web/package.json ./apps/web/package.json
COPY --from=build-web /app/apps/web/index.html ./apps/web/index.html

RUN npm prune --omit=dev --no-audit --no-fund

# ----------------------------------------------------------------------------
# runtime
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV PORT=8080
ENV API_PORT=8080
ENV RUN_WORKER=true

COPY --from=assemble /app/package.json /app/package-lock.json ./
COPY --from=assemble /app/node_modules ./node_modules
COPY --from=assemble /app/packages ./packages
COPY --from=assemble /app/apps ./apps
COPY --from=assemble /app/scripts ./scripts
COPY --from=assemble /app/tsconfig.base.json /app/tsconfig.json ./

RUN chmod +x /app/scripts/start-production.sh /app/scripts/start-worker.sh \
  && test -f /app/scripts/worker-health.mjs

EXPOSE 8080

CMD ["/app/scripts/start-production.sh"]
