# Dockerfile - Multi-stage build for hyre-worker
# Stage 1: Build stage
FROM node:20-alpine AS builder
# … the rest of your build steps …


WORKDIR /app

RUN corepack enable pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

RUN pnpm fetch --frozen-lockfile
# Copy source code and configs
COPY . .
RUN pnpm install --offline --frozen-lockfile
# Generate Prisma client and build TypeScript
RUN npx prisma generate
RUN pnpm build
# Prune to production deps for runtime image
RUN pnpm prune --prod && cp -R node_modules /tmp/node_modules_prod

# Stage 2: Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN corepack enable pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Copy pruned production node_modules from builder stage (optimization)
COPY --from=builder /tmp/node_modules_prod ./node_modules

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy Prisma schema
COPY prisma ./prisma

# Set production environment
ENV NODE_ENV=production

# Expose health check port
EXPOSE 3000

# Health check
# install curl so the HEALTHCHECK works
RUN apk add --no-cache curl

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS --connect-timeout 2 http://localhost:3000/health || exit 1

# Run the worker
USER node
CMD ["node", "dist/main"]

