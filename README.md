# hyre-worker-nestjs

Tripdly's HTTP API and background job service. The `hyre-web` and `hyre-mobile`
clients call this NestJS application; business rules, Postgres data, Redis queues,
provider integrations, and scheduled work live here.

## What this service owns

- Customer and guest APIs for accounts, cars, bookings, payments, referrals, and reviews.
- Fleet-owner, chauffeur-onboarding, and admin operations.
- Maps, places, flight, AI-assisted search, webhook, and WhatsApp booking-agent endpoints.
- BullMQ jobs for notifications, reminders, booking status changes, payouts, and referral work.

The web pages and native UI live in `hyre-web` and `hyre-mobile`, respectively.

## Stack

- NestJS 11 and TypeScript
- Prisma 7 with Postgres
- BullMQ with Redis
- Better Auth
- Fly.io, with Neon databases in deployed environments

External services include Twilio, Flutterwave, email, identity and vehicle verification,
Cloudflare R2, maps, flight data, and AI providers. The validated configuration schema is
the authoritative list of integrations and environment variables.

## Local development

### Requirements

- Node.js `22.12.0` (from [`.nvmrc`](.nvmrc)); `package.json` supports `>=22.12.0`
- pnpm `10.20.0`
- Reachable Postgres and Redis services
- Credentials and configuration required by
  [`src/config/env.config.ts`](src/config/env.config.ts)

This repository does not currently include an example env file or a Compose setup, and it
does not fully document how a new contributor should provision local Postgres, Redis, or
third-party credentials. Obtain the development configuration from the team, then place it
in a gitignored `.env` file. Do not use production credentials or the production database.

```bash
nvm use
corepack enable
pnpm install
pnpm db:generate
pnpm start:dev
```

The API listens on `http://localhost:3000` by default.

## Useful endpoints

- `GET /` returns the service, environment, and deployment identity.
- `GET /health` checks database connectivity.
- `/queues` hosts Bull Board. It uses basic authentication when both
  `BULL_BOARD_USERNAME` and `BULL_BOARD_PASSWORD` are configured.
- `POST /job/trigger/:jobType` exposes operational job triggers only when
  `ENABLE_MANUAL_TRIGGERS=true`. Keep this disabled in production.

## Common commands

```bash
pnpm start:dev      # Run with watch mode
pnpm type-check     # Generate Prisma client and type-check
pnpm lint           # Lint src/
pnpm lint:fix       # Apply lint fixes
pnpm format         # Format src/
pnpm check          # Run Biome checks
pnpm test           # Run unit tests
pnpm test:e2e       # Run end-to-end tests using .env.e2e and Testcontainers
pnpm build          # Generate Prisma client and compile
pnpm start:prod     # Run the compiled service
```

Husky installs during `pnpm install`, and commit messages follow Conventional Commits.

## Environment and deployment

Do not copy an environment-variable list from this README. Use:

- [`src/config/env.config.ts`](src/config/env.config.ts) for the current validated schema.
- [`docs/environments.md`](docs/environments.md) for preview, development, production,
  database, Redis, and deployment rules.
- [`docs/release-command.md`](docs/release-command.md) for the production release process.

Pull requests can receive isolated Fly.io and Neon preview environments. Merging to `main`
updates development; it does not release production. Production is deployed through the
approval-gated GitHub Actions workflow described in the deployment docs. Prisma migrations
run through the Fly.io release command rather than an ad hoc README procedure.

## Contributing

Keep changes focused, add or update tests for behavior changes, and run the relevant checks
above before opening a pull request.
