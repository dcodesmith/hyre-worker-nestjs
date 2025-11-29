#!/bin/bash
set -e
set -o pipefail

# Setup native Redis on Fly.io for hyre-worker-nestjs
# This script creates a Redis instance on Fly.io infrastructure (no managed service fees)

APP_NAME="hyre-worker-nestjs"
REDIS_APP_NAME="hyre-worker-nestjs-redis"
REGION="lhr"
VOLUME_SIZE=1  # GB

echo "🚀 Setting up native Redis for $APP_NAME..."

# Step 1: Create Redis app
echo "📦 Creating Redis app: $REDIS_APP_NAME"
if ! flyctl apps list | grep -q "$REDIS_APP_NAME"; then
  if ! flyctl apps create $REDIS_APP_NAME; then
    echo "❌ Error: Failed to create Redis app. Check Fly.io credentials and permissions."
    exit 1
  fi
  echo "✓ Redis app created successfully"
else
  echo "✓ App $REDIS_APP_NAME already exists, skipping creation..."
fi

# Step 2: Create persistent volume with validation
echo "💾 Creating persistent volume for Redis data..."
EXISTING_VOLUME=$(flyctl volumes list --app $REDIS_APP_NAME --json 2>/dev/null | grep -o '"name":"redis_data"' || echo "")

if [ -z "$EXISTING_VOLUME" ]; then
  if ! flyctl volumes create redis_data \
    --app $REDIS_APP_NAME \
    --region $REGION \
    --size $VOLUME_SIZE \
    --yes; then
    echo "❌ Error: Failed to create volume"
    exit 1
  fi
  echo "✓ Volume created successfully"
else
  echo "✓ Volume 'redis_data' already exists"
  # Validate region
  VOLUME_REGION=$(flyctl volumes list --app $REDIS_APP_NAME --json 2>/dev/null | grep -A 5 '"name":"redis_data"' | grep -o '"region":"[^"]*"' | cut -d'"' -f4 || echo "")
  if [ -n "$VOLUME_REGION" ] && [ "$VOLUME_REGION" != "$REGION" ]; then
    echo "⚠️  Warning: Existing volume is in region '$VOLUME_REGION', expected '$REGION'"
    echo "   This may cause deployment issues. Consider recreating the volume in the correct region."
  fi
fi

# Step 3: Generate and set Redis password
echo "🔐 Generating secure Redis password..."
REDIS_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)

echo "🔑 Setting REDIS_PASSWORD secret for Redis app..."
if ! flyctl secrets set REDIS_PASSWORD="$REDIS_PASSWORD" --app $REDIS_APP_NAME --stage; then
  echo "❌ Error: Failed to set REDIS_PASSWORD secret"
  exit 1
fi

# Step 4: Deploy Redis
echo "🔨 Deploying Redis container..."
if ! flyctl deploy --config fly.redis.toml --yes; then
  echo "❌ Error: Redis deployment failed"
  exit 1
fi

# Step 5: Wait for Redis to be ready and verify
echo "⏳ Waiting for Redis to be ready..."
sleep 10

MAX_RETRIES=6
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if flyctl ssh console --app $REDIS_APP_NAME -C "redis-cli -a $REDIS_PASSWORD ping" 2>/dev/null | grep -q "PONG"; then
    echo "✓ Redis is responding to health checks"
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
    echo "  Waiting for Redis to start (attempt $RETRY_COUNT/$MAX_RETRIES)..."
    sleep 5
  else
    echo "⚠️  Warning: Redis health check failed after $MAX_RETRIES attempts"
    echo "   Deployment may still be in progress. Check status with: flyctl status --app $REDIS_APP_NAME"
  fi
done

# Step 6: Set Redis URL in worker app with authentication
REDIS_URL="redis://:${REDIS_PASSWORD}@${REDIS_APP_NAME}.internal:6379"
echo "🔗 Setting REDIS_URL secret in $APP_NAME..."
if ! flyctl secrets set REDIS_URL="$REDIS_URL" --app $APP_NAME; then
  echo "❌ Error: Failed to set REDIS_URL secret"
  exit 1
fi

echo ""
echo "✅ Redis setup complete!"
echo ""
echo "Redis Internal URL: redis://:****@${REDIS_APP_NAME}.internal:6379"
echo "Your worker app will connect via Fly.io's private network (no internet traffic)"
echo ""
echo "Security features enabled:"
echo "  ✓ Password authentication (32-character random password)"
echo "  ✓ Private network binding (fly-local-6pn)"
echo "  ✓ Memory limits (400MB with LRU eviction)"
echo "  ✓ Data persistence (AOF + periodic snapshots)"
echo "  ✓ Health checks (15s interval)"
echo ""
echo "To verify:"
echo "  flyctl status --app $REDIS_APP_NAME"
echo "  flyctl ssh console --app $APP_NAME -C 'redis-cli -u \$REDIS_URL ping'"
echo ""
echo "To monitor Redis:"
echo "  flyctl ssh console --app $REDIS_APP_NAME"
echo "  redis-cli -a <password> monitor"
