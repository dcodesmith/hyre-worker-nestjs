#!/bin/sh
set -e

# Run database migrations using prisma CLI installed during Docker build
# Version matches @prisma/client (6.19.0) and avoids runtime npm registry access
node_modules/.bin/prisma migrate deploy

# Start the app
exec node dist/main