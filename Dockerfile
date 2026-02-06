# STAGE 1: Build
FROM node:22.12.0-bookworm-slim AS builder

WORKDIR /app

# Install openssl so Prisma can detect the correct engine binary
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Update corepack (bundled version has outdated signing keys) and enable pnpm
RUN npm install -g corepack@latest && corepack enable pnpm

# Copy only lockfiles first for optimal caching
COPY package.json pnpm-lock.yaml ./

# Fetch dependencies (can be cached by Docker)
RUN pnpm fetch

# Copy source and configs
COPY . .

# Install dependencies offline using the cache
RUN pnpm install --offline --frozen-lockfile

# Build the NestJS app (prisma generate runs as part of the build script)
RUN pnpm build

# Copy prisma CLI before pruning (it's a devDependency needed for migrations)
RUN cp -R node_modules/prisma /tmp/prisma_cli && \
    cp -R node_modules/.bin/prisma /tmp/prisma_bin

# Prune dev dependencies for a tiny final image
RUN pnpm prune --prod --ignore-scripts && cp -R node_modules /tmp/node_modules_prod


# STAGE 2: Production
FROM node:22.12.0-bookworm-slim AS production

WORKDIR /app

# Security: Install curl for healthchecks & openssl for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends curl openssl && rm -rf /var/lib/apt/lists/*

# Update corepack and enable pnpm for installing prisma CLI
RUN npm install -g corepack@latest && corepack enable pnpm

# Copy production essentials from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /tmp/node_modules_prod ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Install prisma CLI (version range matches @prisma/client in package.json)
RUN pnpm add -D prisma@^6.19.0

# Copy entrypoint script
COPY --from=builder /app/entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Environment defaults
ENV NODE_ENV=production

# Expose the NestJS port
EXPOSE 3000

# Health check to let Dokploy know the app is actually "Ready"
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# Security: Run as non-root user 'node'
USER node

# Start with entrypoint (runs migrations then starts app)
CMD ["./entrypoint.sh"]