import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { execSync } from "node:child_process";

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
