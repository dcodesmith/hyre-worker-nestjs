#!/bin/sh
set -e

# Run database migrations using prisma CLI copied from builder
# Exact version match with @prisma/client is guaranteed
node_modules/.bin/prisma migrate deploy

# Start the app
exec node dist/main