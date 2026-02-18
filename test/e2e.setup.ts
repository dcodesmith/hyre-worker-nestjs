import { execSync } from "node:child_process";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;

// This function runs once before all tests
export async function setup() {
  try {
    // Start Postgres container
    pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("hyre_e2e_db")
      .withUsername("testuser")
      .withPassword("testpassword")
      .withExposedPorts(5432) // Exposes 5432 inside container to a random host port
      .start();

    // Start Redis container
    redisContainer = await new RedisContainer("redis:7-alpine").withExposedPorts(6379).start();

    // Set environment variables for your application to connect to
    const databaseUrl = pgContainer.getConnectionUri();
    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getMappedPort(6379);
    const redisUrl = `redis://${redisHost}:${redisPort}`;

    // Database and Redis
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.REDIS_HOST = redisHost;
    process.env.REDIS_PORT = redisPort.toString();

    // Auth configuration for e2e tests
    process.env.SESSION_SECRET = "e2e-test-session-secret-at-least-32-chars";
    process.env.AUTH_BASE_URL = "http://localhost:3000";
    process.env.TRUSTED_ORIGINS = "http://localhost:3000, http://localhost:5173";
    process.env.FLIGHTAWARE_WEBHOOK_SECRET = "e2e-test-flightaware-webhook-secret";

    const prismaEnv = { ...process.env, DATABASE_URL: databaseUrl };

    console.log("Generating Prisma client with test database URL...");

    try {
      execSync("npx prisma generate", {
        env: prismaEnv,
        stdio: "inherit",
      });
      console.log("Prisma client generated successfully");
    } catch (error) {
      console.error("Prisma client generation failed:", error);
      throw error;
    }

    console.log("Pushing Prisma schema to test database...");

    try {
      // Use db push for e2e tests since it syncs the full schema without requiring migrations
      // This ensures all tables (including auth tables) are created regardless of migration state
      execSync("npx prisma db push --skip-generate", {
        env: prismaEnv,
        stdio: "inherit",
      });
      console.log("Prisma schema push completed successfully");
    } catch (error) {
      console.error("Prisma schema push failed:", error);
      throw error;
    }

    // Seed roles for authentication tests
    // Dynamic import to avoid loading before prisma generate runs
    console.log("Seeding roles...");
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const roles = ["user", "fleetOwner", "admin", "staff"];
      for (const roleName of roles) {
        await prisma.role.upsert({
          where: { name: roleName },
          update: {},
          create: { name: roleName, description: `${roleName} role` },
        });
      }
      console.log("Roles seeded successfully");
    } finally {
      await prisma.$disconnect();
    }

    // Teardown function to stop containers after tests
    return async () => {
      await pgContainer.stop();
      await redisContainer.stop();
    };
  } catch (error) {
    // Clean up any started containers on failure
    if (pgContainer) {
      await pgContainer.stop().catch((error) => {
        console.error("Failed to stop PostgreSQL container during cleanup:", error);
      });
    }

    if (redisContainer) {
      await redisContainer.stop().catch((error) => {
        console.error("Failed to stop Redis container during cleanup:", error);
      });
    }

    throw error;
  }
}
