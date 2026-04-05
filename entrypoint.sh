#!/bin/sh
set -e

# Run database migrations using Prisma CLI installed during Docker build.
# The Dockerfile pins Prisma CLI to the same version as @prisma/client.
node_modules/.bin/prisma migrate deploy

# Start the app
exec node dist/main