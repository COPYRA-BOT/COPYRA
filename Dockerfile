# COPYRA production image for DigitalOcean App Platform / Railway / Docker.
#
# Build context MUST be the repository root so packages can resolve
# ../../tsconfig.base.json. Do not set the App Platform "Source Directory"
# to apps/api or any subdirectory.
#
# Secrets are injected at runtime via platform env vars. Nothing under .env
# is copied into the image (.dockerignore).

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Workspace root manifests + the shared TypeScript base every package extends.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./

COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

# Prisma generate reads DATABASE_URL from the environment. This build-time
# placeholder is not a real credential and is overridden at runtime.
ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV DATABASE_URL=${DATABASE_URL}

RUN npm ci
RUN npm run db:generate && npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
# App Platform injects PORT to match the component HTTP Port. Default 8080 so
# a UI left on the DO default still reaches the API. Local .env can override.
ENV PORT=8080
ENV API_PORT=8080

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.base.json /app/tsconfig.json ./

EXPOSE 8080 43127

# Default process is the API. On App Platform, create separate components
# (or override the run command) for worker and web — see docs/DEPLOY.md.
CMD ["npm", "run", "start", "-w", "@copyra/api"]
