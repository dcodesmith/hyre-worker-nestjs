# Hyre Worker - NestJS

   [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=dcodesmith_hyre-worker-nestjs&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=dcodesmith_hyre-worker-nestjs)

A production-ready NestJS worker service for automated booking management, handling reminders, status transitions, notifications, and payment processing for chauffeur-driven ride-booking platform.

## Features

- **Multi-Channel Notifications**: Automated email (Resend) and WhatsApp (Twilio) messaging
- **Smart Reminders**: Time-based booking start/end reminders with 1-hour advance notice
- **Status Automation**: Automatic booking lifecycle transitions (Confirmed → Active → Completed)
- **Automated Payouts**: Fleet owner settlement via Flutterwave after booking completion
- **Referral Rewards**: Automated referral reward processing on booking completion with configurable release conditions
- **Queue Monitoring**: Real-time Bull Board dashboard for queue inspection and management
- **Health Checks**: Service health monitoring via Terminus
- **Retry Logic**: Configurable exponential backoff for failed jobs
- **Event Tracking**: Comprehensive job lifecycle monitoring (active, completed, failed, stalled)

## Architecture

### Technology Stack

**Core Framework**
- **NestJS 11** - Progressive Node.js framework with TypeScript
- **BullMQ 5.x** - Redis-based distributed job queue system
- **Prisma** - Type-safe database ORM
- **Redis** - Queue storage and job coordination

**Queue Management**
- **@nestjs/bullmq** - Official NestJS integration for BullMQ
- **@bull-board/nestjs** - Queue monitoring dashboard with Express adapter
- **Worker Events** - Real-time job lifecycle tracking (`@OnWorkerEvent` decorators)

**External Integrations**
- **Resend** - Transactional email delivery
- **Twilio** - WhatsApp Business messaging
- **Flutterwave** - Payment processing and bank transfers

**Testing & Quality**
- **Vitest 3.x** - Fast unit and e2e test runner with coverage
- **Testcontainers** - PostgreSQL and Redis containers for e2e testing
- **Biome** - Fast linter and formatter
- **SonarQube** - Code quality analysis

### System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Cron Schedulers                      │
│  (Every hour: Reminders, Status Updates, Payouts)       │
└──────────────────┬──────────────────────────────────────┘
                   │ Enqueue Jobs
                   ▼
┌─────────────────────────────────────────────────────────┐
│              BullMQ Queues (Redis-backed)               │
│  • reminders-queue         (Booking reminders)          │
│  • status-updates-queue    (Status transitions)         │
│  • notifications-queue     (Email/WhatsApp delivery)    │
│  • referral-queue          (Referral reward processing) │
└──────────────────┬──────────────────────────────────────┘
                   │ Process Jobs
                   ▼
┌─────────────────────────────────────────────────────────┐
│                    Job Processors                       │
│  • ReminderProcessor       (Fetch & queue reminders)    │
│  • StatusChangeProcessor   (Update statuses + payouts)  │
│  • NotificationProcessor   (Send emails/WhatsApp)       │
│  • ReferralProcessor       (Process referral rewards)   │
└─────────────────────────────────────────────────────────┘
```

## Modules

### Core Modules

**DatabaseModule** (`src/modules/database/`)
- Global Prisma ORM client with connection lifecycle management
- Query logging and slow query detection (>1000ms)
- Automatic connect/disconnect on app startup/shutdown

**FlutterwaveModule** (`src/modules/flutterwave/`)
- Global Flutterwave API client
- Bank transfer initiation and verification
- Request/response interceptors with sensitive data masking
- Custom error handling for payment operations

### Feature Modules

**NotificationModule** (`src/modules/notification/`)
- **Queue**: `notifications-queue` (concurrency: 5)
- **Services**:
  - `NotificationService`: Queues multi-channel notifications
  - `EmailService`: Resend API integration with React Email templates
  - `WhatsAppService`: Twilio WhatsApp Business API integration
- **Processor**: `NotificationProcessor` - Handles email/WhatsApp delivery
- **Template Mappers**: Dynamic content generation for different notification types
  - `BookingStatusMapper` - Status change notifications
  - `BookingReminderStartMapper` - Trip start reminders
  - `BookingReminderEndMapper` - Trip end reminders
  - `FallbackTemplateMapper` - Default template handler

**ReminderModule** (`src/modules/reminder/`)
- **Queue**: `reminders-queue`
- **Scheduler**: Hourly cron jobs for reminder checks
- **Jobs**:
  - `booking-leg-start-reminder`: Finds bookings starting within 1 hour
  - `booking-leg-end-reminder`: Finds bookings ending within 1 hour (handles extensions)
- **Logic**: Queries CONFIRMED/PAID bookings with assigned chauffeurs

**StatusChangeModule** (`src/modules/status-change/`)
- **Queue**: `status-updates-queue`
- **Scheduler**: Hourly cron jobs for status transitions
- **Jobs**:
  - `confirmed-to-active`: Updates bookings at start time
  - `active-to-completed`: Updates bookings at end time + initiates payout
- **Integration**: Calls PaymentModule for fleet owner settlements

**PaymentModule** (`src/modules/payment/`)
- Payout orchestration for completed bookings
- Validates fleet owner bank details before transfer
- Creates and tracks `PayoutTransaction` records
- Handles Flutterwave transfer failures and retries

**ReferralModule** (`src/modules/referral/`)
- **Queue**: `referral-queue` (concurrency: 1)
- **Job**: `process-referral-completion` - Triggered after booking completion
- **Features**:
  - Configurable release conditions (PAID or COMPLETED)
  - Optional expiry window validation
  - Idempotent reward release (prevents duplicate processing)
  - Automatic referee discount marking
  - Updates referrer stats (total rewards granted/pending)
- **Integration**: Queued by StatusChangeModule when bookings transition to COMPLETED
- **Configuration**: Driven by `ReferralProgramConfig` table (REFERRAL_ENABLED, REFERRAL_RELEASE_CONDITION, REFERRAL_EXPIRY_DAYS)

**HealthModule** (`src/modules/health/`)
- NestJS Terminus-based health checks
- Monitors: Database connectivity (Prisma ping)
- Endpoint: `GET /health`

**JobModule** (`src/modules/job/`)
- Manual job triggering for testing/admin operations
- **Endpoint**: `POST /job/trigger/:jobType` (accepts: `start-reminders`, `end-reminders`, `activate-bookings`, `complete-bookings`)
- **Rate limiting**: 1 request per hour per job type (independent limits using custom JobThrottlerGuard)
- **Error handling**: Structured errors with error codes (JOB.RATE_LIMIT.EXCEEDED, JOB.VALIDATION.INVALID_TYPE, JOB.AUTH.MANUAL_TRIGGERS_DISABLED)
- Requires: `ENABLE_MANUAL_TRIGGERS=true` environment variable

## Queue System (BullMQ)

### Queue Configurations

**notifications-queue**
```typescript
{
  name: "notifications-queue",
  concurrency: 5,  // Process 5 notifications simultaneously
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,  // Keep last 100 successful jobs
    removeOnFail: 50        // Keep last 50 failed jobs
  }
}
```

**reminders-queue**
```typescript
{
  name: "reminders-queue",
  concurrency: 1,
  jobTypes: ["booking-leg-start-reminder", "booking-leg-end-reminder"]
}
```

**status-updates-queue**
```typescript
{
  name: "status-updates-queue",
  concurrency: 1,
  jobTypes: ["confirmed-to-active", "active-to-completed"]
}
```

**referral-queue**
```typescript
{
  name: "referral-queue",
  concurrency: 1,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,  // Keep last 100 successful jobs
    removeOnFail: 50        // Keep last 50 failed jobs
  }
}
```

### Worker Event Listeners

All processors include `@OnWorkerEvent` decorators for comprehensive monitoring:

- **`active`**: Job starts processing (logs job ID and attempt number)
- **`completed`**: Job finishes successfully (logs duration)
- **`failed`**: Job fails (logs error with stack trace and retry info)
- **`stalled`**: Job becomes unresponsive (logs warning)
- **`progress`**: Job reports progress updates (debug logging)

### Bull Board Dashboard

Access the queue monitoring dashboard at: **`http://localhost:3000/queues`**

**Features:**
- Real-time queue statistics (active, waiting, completed, failed)
- Job inspection and details
- Manual job retry/removal
- Queue pause/resume controls
- Job timeline visualization

## Scheduling

All jobs run **hourly** using `@nestjs/schedule` cron decorators:

```typescript
@Cron('0 * * * *', { timeZone: 'Africa/Lagos' })
```

**Scheduled Operations:**
1. **Reminder Check** (Every hour at :00)
   - Find bookings starting in next 60 minutes → Queue reminders
   - Find bookings ending in next 60 minutes → Queue reminders

2. **Status Updates** (Every hour at :00)
   - Update CONFIRMED → ACTIVE (at booking start time)
   - Update ACTIVE → COMPLETED (at booking end time)

3. **Payout Initiation** (Triggered by ACTIVE → COMPLETED)
   - Validate fleet owner bank details
   - Create payout transaction
   - Call Flutterwave transfer API
   - Update transaction status

4. **Referral Reward Processing** (Triggered by ACTIVE → COMPLETED)
   - Queue referral completion job
   - Validate release conditions and expiry
   - Release pending rewards
   - Update referrer stats

## API Endpoints

### Health & Monitoring

```http
GET /health
```
Returns service health status
```json
{
  "status": "ok",
  "info": { "database": { "status": "up" } },
  "error": {},
  "details": { "database": { "status": "up" } }
}
```

```http
GET /queues
```
Bull Board dashboard (HTML interface)

### Manual Job Triggers

⚠️ **Requires**: `ENABLE_MANUAL_TRIGGERS=true` environment variable

**Rate Limiting**: 1 request per hour per job type (independent limits)

All endpoints return `202 Accepted` on success.

```http
POST /job/trigger/start-reminders
```
Manually trigger booking start reminders
- Response: `{ "success": true, "message": "Start reminder job triggered" }`

```http
POST /job/trigger/end-reminders
```
Manually trigger booking end reminders
- Response: `{ "success": true, "message": "End reminder job triggered" }`

```http
POST /job/trigger/activate-bookings
```
Manually trigger CONFIRMED → ACTIVE status updates
- Response: `{ "success": true, "message": "Activate bookings job triggered" }`

```http
POST /job/trigger/complete-bookings
```
Manually trigger ACTIVE → COMPLETED status updates + payouts + referral processing
- Response: `{ "success": true, "message": "Complete bookings job triggered" }`

**Error Responses**:
- `403` - Manual triggers disabled (JOB.AUTH.MANUAL_TRIGGERS_DISABLED)
- `400` - Invalid job type (JOB.VALIDATION.INVALID_TYPE)
- `429` - Rate limit exceeded (JOB.RATE_LIMIT.EXCEEDED) - includes `retryAfter` timestamp

## Environment Variables

### Required Configuration

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Redis (for BullMQ)
REDIS_URL=redis://localhost:6379

# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=noreply@yourdomain.com
APP_NAME=Hyre

# WhatsApp (Twilio)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxx
TWILIO_SECRET=xxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=whatsapp:+1234567890
TWILIO_WEBHOOK_URL=https://yourdomain.com/webhooks/twilio  # Optional

# Payments (Flutterwave)
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-xxxxxxxxxxxx
FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_TEST-xxxxxxxxxxxx
FLUTTERWAVE_BASE_URL=https://api.flutterwave.com
FLUTTERWAVE_WEBHOOK_SECRET=xxxxxxxxxxxxxxxx
FLUTTERWAVE_WEBHOOK_URL=https://yourdomain.com/webhooks/flutterwave

# Server
PORT=3000
TZ=Africa/Lagos
ENABLE_MANUAL_TRIGGERS=false  # Set to 'true' to enable manual trigger endpoints
```

## Development

### Prerequisites
- Node.js 22.11.0 (exact version specified in engines)
- pnpm 10.20.0 (required package manager)
- Redis server (for BullMQ)
- PostgreSQL database

### Installation

```bash
# Install dependencies
pnpm install

# Generate Prisma client
pnpm run db:generate

# Start development server with hot reload
pnpm run start:dev

# Start with debugging
pnpm run start:debug
```

### Scripts

```bash
# Development
pnpm run start:dev          # Hot reload development server
pnpm run start:debug        # Start with Node debugger attached

# Production
pnpm run build              # Compile TypeScript to dist/
pnpm run start:prod         # Start production build

# Testing
pnpm run test               # Run unit tests (Vitest)
pnpm run test:watch         # Watch mode for tests
pnpm run test:coverage      # Generate coverage report
pnpm run test:coverage:ci   # CI-optimized coverage with NYC reporter
pnpm run test:ui            # Launch Vitest web UI
pnpm run test:e2e           # Run end-to-end tests with Testcontainers

# Code Quality
pnpm run lint               # Run Biome linting
pnpm run lint:fix           # Auto-fix linting issues
pnpm run format             # Format code with Biome
pnpm run check              # Run all Biome checks
pnpm run check:fix          # Fix all Biome issues

# Database
pnpm run db:generate        # Generate Prisma client from schema
```

## Testing

### Testing Stack
- **Framework**: Vitest 3.2.4 with NestJS testing utilities
- **Coverage**: V8 coverage provider
- **E2E Testing**: Testcontainers for PostgreSQL and Redis
- **Strategy**: Unit tests with mocked dependencies, E2E tests with real containers

### Test Structure

```typescript
describe('ReminderService', () => {
  let service: ReminderService;
  let mockDatabaseService: DatabaseService;
  let mockNotificationService: NotificationService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReminderService,
        { provide: DatabaseService, useValue: mockDatabase },
        { provide: NotificationService, useValue: mockNotification }
      ]
    }).compile();

    service = module.get<ReminderService>(ReminderService);
  });

  it('should queue reminders for bookings starting soon', async () => {
    // Test implementation
  });
});
```

### Running Tests

```bash
# Run all unit tests
pnpm run test

# Watch mode (re-run on file changes)
pnpm run test:watch

# Generate HTML coverage report
pnpm run test:coverage
# Report available at: ./coverage/index.html

# Launch interactive test UI
pnpm run test:ui
# UI available at: http://localhost:51204/__vitest__/

# Run end-to-end tests (spins up PostgreSQL and Redis via Testcontainers)
pnpm run test:e2e
```

## Docker

### Build & Run

```bash
# Build Docker image
docker build -t hyre-worker .

# Run container
docker run -p 3000:3000 --env-file .env hyre-worker
```

### Docker Configuration
- **Base Image**: node:22-alpine (multi-stage build)
- **User**: node (non-root for security)
- **Health Check**: Curl to `GET /health` every 30 seconds
- **Exposed Port**: 3000

## Production Deployment (Fly.io)

### Prerequisites
- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account and logged in (`flyctl auth login`)

### Setup Native Redis on Fly.io

This app requires Redis for BullMQ queues. Use the automated setup script to deploy a native Redis instance (no managed service fees):

```bash
# Run the setup script to create and deploy Redis
./scripts/setup-redis.sh
```

This will:
1. Create a new Fly.io app: `hyre-worker-nestjs-redis`
2. Generate a secure 32-character random password for Redis authentication
3. Deploy Redis 7 Alpine container with persistent storage and security hardening
4. Set the `REDIS_URL` secret (with authentication) in your worker app
5. Connect via Fly.io's internal private network (`.internal` domain)

**Security Features:**
- Password authentication (32-character random password)
- Private network binding (no public exposure)
- Memory limits (400MB with LRU eviction policy)
- Data persistence (AOF + periodic snapshots)
- Health checks (15s interval)

**Manual Setup** (alternative):

```bash
# 1. Create Redis app
flyctl apps create hyre-worker-nestjs-redis

# 2. Create persistent volume
flyctl volumes create redis_data \
  --app hyre-worker-nestjs-redis \
  --region lhr \
  --size 1

# 3. Generate and set Redis password
REDIS_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
flyctl secrets set REDIS_PASSWORD="$REDIS_PASSWORD" \
  --app hyre-worker-nestjs-redis \
  --stage

# 4. Deploy Redis
flyctl deploy --config fly.redis.toml

# 5. Set Redis URL in worker app (with authentication)
flyctl secrets set REDIS_URL="redis://:${REDIS_PASSWORD}@hyre-worker-nestjs-redis.internal:6379" \
  --app hyre-worker-nestjs
```

### Verify Redis Connection

```bash
# Check Redis app status
flyctl status --app hyre-worker-nestjs-redis

# Test Redis from worker app
flyctl ssh console --app hyre-worker-nestjs -C 'redis-cli -u $REDIS_URL ping'
# Should return: PONG

# Monitor Redis activity (requires password from secrets)
flyctl ssh console --app hyre-worker-nestjs-redis
redis-cli -a $REDIS_PASSWORD monitor
```

### Deploy Worker App

```bash
# Deploy the worker application
flyctl deploy

# View logs
flyctl logs

# Check application status
flyctl status
```

### Configuration Files

- [`fly.toml`](fly.toml) - Main worker app configuration
- [`fly.redis.toml`](fly.redis.toml) - Redis instance configuration
- [`scripts/setup-redis.sh`](scripts/setup-redis.sh) - Automated Redis setup

### Cost Optimization

The native Redis setup runs on Fly.io's infrastructure with:
- **Redis App**: 1 shared CPU, 512MB RAM
- **Persistent Volume**: 1GB storage
- **Network**: Internal `.internal` domain (no internet traffic)
- **Estimated Cost**: ~$2-3/month (vs $7+/month for managed Redis)

Both apps run in the `lhr` (London) region for optimal latency.


### Build for Production

```bash
# Install production dependencies only
pnpm install --prod

# Generate Prisma client
pnpm run db:generate

# Build application
pnpm run build

# Start production server
pnpm run start:prod
```

### Monitoring

- **Queue Dashboard**: Access `/queues` to monitor job processing
- **Health Endpoint**: Poll `/health` for database connectivity
- **Logs**: Application logs include job IDs, durations, and error traces
- **Job Events**: Worker events logged for all queue operations

## Data Flow Examples

### Booking Reminder Flow

```
1. Cron Scheduler (hourly) → Enqueue "booking-leg-start-reminder"
2. ReminderProcessor → ReminderService.sendBookingStartReminderEmails()
3. Query: SELECT bookings WHERE legStartTime IN (now, now+1h)
4. For each booking → NotificationService.queueBookingReminderNotifications()
5. Enqueue "send-notification" jobs (customer + chauffeur)
6. NotificationProcessor → EmailService.sendEmail() + WhatsAppService.sendMessage()
7. Deliver to: customer email, customer WhatsApp, chauffeur email, chauffeur WhatsApp
```

### Status Update & Payout Flow

```
1. Cron Scheduler (hourly) → Enqueue "active-to-completed"
2. StatusChangeProcessor → StatusChangeService.updateBookingsFromActiveToCompleted()
3. Query: SELECT bookings WHERE status=ACTIVE AND endTime IN current_hour
4. For each booking:
   a. Update booking.status = COMPLETED
   b. PaymentService.initiatePayout()
      - Validate fleet owner bank details
      - Create PayoutTransaction (PENDING_DISBURSEMENT)
      - FlutterwaveService.initiatePayout() → Flutterwave API
      - Update transaction status (PROCESSING or FAILED)
   c. Update car.status = AVAILABLE
   d. NotificationService.queueBookingStatusNotifications()
   e. ReferralService.queueReferralProcessing()
      - Queue "process-referral-completion" job
5. NotificationProcessor → Send completion notifications
6. ReferralProcessor → Process referral rewards
   - Check ReferralProgramConfig (REFERRAL_ENABLED, REFERRAL_RELEASE_CONDITION)
   - Validate booking has referral applied (referralStatus = APPLIED)
   - Optional: Validate expiry window (REFERRAL_EXPIRY_DAYS)
   - Mark referee discount as used
   - Release pending reward (PENDING → RELEASED)
   - Update UserReferralStats (totalRewardsGranted, totalRewardsPending)
   - Update booking.referralStatus = REWARDED
```

## Contributing

### Code Quality Standards
- **Linting**: Biome (run `pnpm run lint` before committing)
- **Formatting**: Biome (run `pnpm run format`)
- **Tests**: Add unit tests for new services
- **TypeScript**: Strict mode enabled
- **Commit Messages**: Conventional Commits format

### SonarQube Integration
Code quality metrics tracked via SonarQube (see `sonar-project.properties`)

## License

Proprietary - Hyre Technologies

## Support

For issues or questions, contact the development team or file an issue in the project repository.

---

**Built with** ❤️ **using NestJS, BullMQ, and TypeScript**
