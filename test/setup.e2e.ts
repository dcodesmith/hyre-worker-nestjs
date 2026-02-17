import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var __E2E_WORKER_ISOLATION_INITIALIZED__: boolean | undefined;
}

function getWorkerId(): string {
  return process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "0";
}

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function withRedisDb(redisUrl: string, dbIndex: number): string {
  const url = new URL(redisUrl);
  url.pathname = `/${dbIndex}`;
  return url.toString();
}

async function initializeWorkerIsolation(): Promise<void> {
  if (globalThis.__E2E_WORKER_ISOLATION_INITIALIZED__) {
    return;
  }

  const baseDatabaseUrl = process.env.DATABASE_URL;
  const baseRedisUrl = process.env.REDIS_URL;

  if (!baseDatabaseUrl) {
    throw new Error("DATABASE_URL is not set in e2e setup");
  }
  if (!baseRedisUrl) {
    throw new Error("REDIS_URL is not set in e2e setup");
  }

  const workerId = getWorkerId();
  const schema = `e2e_w${workerId}`;
  const workerDatabaseUrl = withSchema(baseDatabaseUrl, schema);
  const workerRedisDb = 10 + Number(workerId);
  const workerRedisUrl = withRedisDb(baseRedisUrl, workerRedisDb);

  // Scope each worker to isolated database schema and Redis DB.
  process.env.DATABASE_URL = workerDatabaseUrl;
  process.env.REDIS_URL = workerRedisUrl;
  process.env.E2E_WORKER_SCHEMA = schema;

  const adminPrisma = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
  try {
    await adminPrisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await adminPrisma.$disconnect();
  }

  const prismaEnv = { ...process.env, DATABASE_URL: workerDatabaseUrl };
  execSync("npx prisma db push --skip-generate", {
    env: prismaEnv,
    stdio: "inherit",
  });

  const workerPrisma = new PrismaClient({ datasourceUrl: workerDatabaseUrl });
  try {
    const roles = ["user", "fleetOwner", "admin", "staff"];
    for (const roleName of roles) {
      await workerPrisma.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName, description: `${roleName} role` },
      });
    }
  } finally {
    await workerPrisma.$disconnect();
  }

  globalThis.__E2E_WORKER_ISOLATION_INITIALIZED__ = true;
}

await initializeWorkerIsolation();

// Mock email template rendering functions to avoid React dependency in e2e tests
// The NotificationProcessor imports these functions which use @react-email/components (React)
// Since BullMQ workers are created independently of NestJS DI, we need to mock at module level
vi.mock("../src/templates/emails", () => ({
  renderBookingConfirmationEmail: vi
    .fn()
    .mockResolvedValue("<html>Mocked booking confirmation</html>"),
  renderBookingStatusUpdateEmail: vi.fn().mockResolvedValue("<html>Mocked status update</html>"),
  renderBookingReminderEmail: vi.fn().mockResolvedValue("<html>Mocked reminder</html>"),
  renderAuthOTPEmail: vi.fn().mockResolvedValue("<html>Mocked OTP email</html>"),
  renderFleetOwnerNewBookingEmail: vi
    .fn()
    .mockResolvedValue("<html>Mocked fleet owner notification</html>"),
}));

// Mock the EmailService to prevent actual API calls to Resend during e2e tests
vi.mock("../src/modules/notification/email.service", () => ({
  EmailService: vi.fn().mockImplementation(() => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
  })),
}));
