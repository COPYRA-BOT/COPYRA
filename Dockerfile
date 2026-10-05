FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY docs ./docs
COPY tsconfig.json vitest.config.ts ./
RUN npm install
RUN npm run db:generate && npm run build
ENV NODE_ENV=production
ENV API_PORT=41717
EXPOSE 41717 43127
CMD ["npm", "run", "start", "-w", "@copyra/api"]
