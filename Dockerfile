# COPYRA production image for DigitalOcean App Platform.
# Build context MUST be the repository root.

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# --- Dependency layer (cached when lockfile / workspace manifests unchanged) ---
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV DATABASE_URL=${DATABASE_URL}

RUN npm ci --no-audit --no-fund

# --- Source + compile (invalidates only when code changes) ---
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN npm run db:generate && npm run build

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

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.base.json /app/tsconfig.json ./

RUN chmod +x /app/scripts/start-production.sh

EXPOSE 8080

CMD ["/app/scripts/start-production.sh"]
