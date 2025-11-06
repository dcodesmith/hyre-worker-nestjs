# Hyre Worker - NestJS

A production-ready NestJS worker service for automated booking management, handling reminders, status transitions, notifications, and payment processing for chauffeur-driven ride-booking platform.

## Features

- **📧 Multi-Channel Notifications**: Automated email (Resend) and WhatsApp (Twilio) messaging
- **⏰ Smart Reminders**: Time-based booking start/end reminders with 1-hour advance notice
- **🔄 Status Automation**: Automatic booking lifecycle transitions (Confirmed → Active → Completed)
- **💰 Automated Payouts**: Fleet owner settlement via Flutterwave after booking completion
- **📊 Queue Monitoring**: Real-time Bull Board dashboard for queue inspection and management
- **🏥 Health Checks**: Service health monitoring via Terminus
- **🔁 Retry Logic**: Configurable exponential backoff for failed jobs
- **📈 Event Tracking**: Comprehensive job lifecycle monitoring (active, completed, failed, stalled)

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
- **Vitest 3.x** - Fast unit test runner with coverage
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
└──────────────────┬──────────────────────────────────────┘
                   │ Process Jobs
                   ▼
┌─────────────────────────────────────────────────────────┐
│                    Job Processors                       │
│  • ReminderProcessor       (Fetch & queue reminders)    │
│  • StatusChangeProcessor   (Update statuses + payouts)  │
│  • NotificationProcessor   (Send emails/WhatsApp)       │
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

**HealthModule** (`src/modules/health/`)
- NestJS Terminus-based health checks
- Monitors: Database connectivity (Prisma ping)
- Endpoint: `GET /health`

**JobModule** (`src/modules/job/`)
- Manual job triggering for testing/admin operations
- Rate limited: 5 requests per 60 seconds
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

All endpoints return `202 Accepted` on success.

```http
POST /job/trigger/reminders
```
Manually trigger booking start reminders
- Rate limit: 5 requests per 60 seconds
- Response: `{ "success": true, "message": "Reminder job triggered" }`

```http
POST /job/trigger/end-reminders
```
Manually trigger booking end reminders

```http
POST /job/trigger/status-updates
```
Manually trigger CONFIRMED → ACTIVE status updates

```http
POST /job/trigger/complete-bookings
```
Manually trigger ACTIVE → COMPLETED status updates + payouts

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
- Node.js >= 20.0.0
- pnpm 10.13.1 (required package manager)
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
- **Strategy**: Unit tests with mocked dependencies

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
# Run all tests
pnpm run test

# Watch mode (re-run on file changes)
pnpm run test:watch

# Generate HTML coverage report
pnpm run test:coverage
# Report available at: ./coverage/index.html

# Launch interactive test UI
pnpm run test:ui
# UI available at: http://localhost:51204/__vitest__/
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
- **Base Image**: node:20-alpine (multi-stage build)
- **User**: node (non-root for security)
- **Health Check**: Curl to `GET /health` every 30 seconds
- **Exposed Port**: 3000

## Production Deployment

### Pre-deployment Checklist

1. **Environment Variables**: All required vars configured
2. **Database**: Migrations applied (`prisma migrate deploy`)
3. **Redis**: Connection tested and accessible
4. **External Services**: API keys validated (Resend, Twilio, Flutterwave)
5. **Timezone**: `TZ` env var set correctly (affects cron scheduling)
6. **Manual Triggers**: `ENABLE_MANUAL_TRIGGERS` disabled in production

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
5. NotificationProcessor → Send completion notifications
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
