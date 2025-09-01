# Hyre Worker - NestJS

A NestJS-based worker service for handling booking reminders, status updates, and payment processing.

## Features

- **Booking Reminders**: Automated email and WhatsApp reminders for booking start/end times
- **Status Updates**: Automatic booking status transitions (confirmed → active → completed)
- **Payment Processing**: Fleet owner payout processing via Flutterwave
- **Queue Management**: Bull queues for reliable job processing
- **Health Monitoring**: Health checks and queue statistics endpoints

## Architecture

### Modules

- **RedisModule**: Global Redis client management
- **DatabaseModule**: Prisma database client (global)
- **SharedModule**: Common utilities and helper services (global)
- **FlutterwaveModule**: Flutterwave payment client (global)
- **PaymentModule**: Payment processing and payout logic
- **ReminderModule**: Email and WhatsApp reminder services
- **StatusChangeModule**: Booking status transition logic
- **HealthModule**: Health checks and monitoring endpoints

### Services

- **EmailService**: Resend-based email delivery
- **WhatsAppService**: Twilio-based WhatsApp messaging
- **FlutterwaveService**: Flutterwave payment processing
- **PaymentService**: Payout orchestration
- **ReminderService**: Booking reminder logic
- **StatusChangeService**: Status transition logic

### Scheduling

Uses `@nestjs/schedule` for cron-based job scheduling:

- **Booking Start Reminders**: `0 6-11,22 * * *` (6AM-11AM, 10PM daily)
- **Booking End Reminders**: `0 4,18-23 * * *` (4AM, 6PM-11PM daily)
- **Confirmed → Active**: `0 7-12,23 * * *` (7AM-12PM, 11PM daily)
- **Active → Completed**: `0 0,5,19-23 * * *` (12AM, 5AM, 7PM-11PM daily)

## Scripts

```bash
# Development
pnpm run start:dev          # Start with hot reload
pnpm run start:debug        # Start with debugging

# Production
pnpm run build              # Build the application
pnpm run start:prod         # Start production build

# Code Quality
pnpm run lint               # Run Biome linting
pnpm run lint:fix           # Fix linting issues
pnpm run format             # Format code with Biome
pnpm run check              # Run all Biome checks
pnpm run check:fix          # Fix all Biome issues



# Database
pnpm run db:generate        # Generate Prisma client
```

## Environment Variables

Required environment variables:

```env
# Database
DATABASE_URL=

# Redis
REDIS_URL=

# Email (Resend)
RESEND_API_KEY=
APP_NAME=

# WhatsApp (Twilio)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_SECRET=
TWILIO_WHATSAPP_NUMBER=
TWILIO_WEBHOOK_URL=

# Payments (Flutterwave)
FLUTTERWAVE_SECRET_KEY=
FLUTTERWAVE_PUBLIC_KEY=
FLUTTERWAVE_BASE_URL=
FLUTTERWAVE_WEBHOOK_SECRET=
FLUTTERWAVE_WEBHOOK_URL=

# Server
PORT=3000
```

## API Endpoints

- `GET /health` - Health check
- `GET /queue-stats` - Queue statistics
- `POST /trigger/reminders` - Manual reminder trigger
- `POST /trigger/end-reminders` - Manual end reminder trigger
- `POST /trigger/status-updates` - Manual status update trigger
- `POST /trigger/complete-bookings` - Manual booking completion trigger

## Development

1. Install dependencies: `pnpm install`
2. Set up environment variables
3. Generate Prisma client: `pnpm run db:generate`
4. Start development server: `pnpm run start:dev`

## Code Quality

This project uses:
- **Biome** for linting and formatting
- **SonarQube** for code quality analysis (see `sonar-project.properties`)
- **TypeScript** with strict configuration
