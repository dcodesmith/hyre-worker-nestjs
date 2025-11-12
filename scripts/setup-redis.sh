#!/bin/bash
set -e

# Setup native Redis on Fly.io for hyre-worker-nestjs
# This script creates a Redis instance on Fly.io infrastructure (no managed service fees)

APP_NAME="hyre-worker-nestjs"
REDIS_APP_NAME="hyre-worker-nestjs-redis"
REGION="lhr"
VOLUME_SIZE=1  # GB

echo "🚀 Setting up native Redis for $APP_NAME..."

# Step 1: Create Redis app
echo "📦 Creating Redis app: $REDIS_APP_NAME"
flyctl apps create $REDIS_APP_NAME || echo "App already exists, continuing..."

# Step 2: Create persistent volume
echo "💾 Creating persistent volume for Redis data..."
flyctl volumes create redis_data \
  --app $REDIS_APP_NAME \
  --region $REGION \
  --size $VOLUME_SIZE \
  --yes || echo "Volume may already exist, continuing..."

# Step 3: Deploy Redis
echo "🔨 Deploying Redis container..."
flyctl deploy --config fly.redis.toml --yes

# Step 4: Set Redis URL in worker app
REDIS_URL="redis://${REDIS_APP_NAME}.internal:6379"
echo "🔗 Setting REDIS_URL secret in $APP_NAME..."
flyctl secrets set REDIS_URL="$REDIS_URL" --app $APP_NAME

echo ""
echo "✅ Redis setup complete!"
echo ""
echo "Redis Internal URL: $REDIS_URL"
echo "Your worker app will connect via Fly.io's private network (no internet traffic)"
echo ""
echo "To verify:"
echo "  flyctl status --app $REDIS_APP_NAME"
echo "  flyctl ssh console --app $APP_NAME -C 'redis-cli -u \$REDIS_URL ping'"
echo ""
echo "To monitor Redis:"
echo "  flyctl ssh console --app $REDIS_APP_NAME"
echo "  redis-cli monitor"
