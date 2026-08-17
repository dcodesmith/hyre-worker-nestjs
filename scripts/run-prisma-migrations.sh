#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required to run Prisma migrations." >&2
  exit 1
fi

# Prisma uses a session-level advisory lock for migrations. Neon pooled
# connections can retain that lock after Prisma exits, so migrate through the
# corresponding direct endpoint. DIRECT_DATABASE_URL can override derivation.
MIGRATION_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
MIGRATION_URL="$(
  MIGRATION_URL="$MIGRATION_URL" node -e '
    const url = new URL(process.env.MIGRATION_URL);
    if (url.hostname.endsWith(".neon.tech")) {
      url.hostname = url.hostname.replace(/-pooler(?=\.)/, "");
    }
    process.stdout.write(url.toString());
  '
)"

PRISMA_BIN="${PRISMA_BIN:-node_modules/.bin/prisma}"
DATABASE_URL="$MIGRATION_URL" exec "$PRISMA_BIN" migrate deploy
