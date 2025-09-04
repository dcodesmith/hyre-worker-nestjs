# Dockerfile - Multi-stage build for hyre-worker
# Stage 1: Build stage
FROM node:20-alpine AS builder
# … the rest of your build steps …


WORKDIR /app

RUN corepack enable pnpm

# Copy package and workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm fetch --frozen-lockfile
# Copy source code and configs
COPY . .
RUN pnpm install --offline --frozen-lockfile
# Generate Prisma client and build TypeScript
RUN npx prisma generate
RUN pnpm build

# Stage 2: Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN corepack enable pnpm

# Copy package and workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install only production dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy Prisma schema and generate client (needed at runtime)
COPY prisma ./prisma
RUN npx prisma generate

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

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
CMD ["pnpm", "start"]

