import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { execSync } from "node:child_process";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;

// This function runs once before all tests
export async function setup() {
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

  console.log("Running Prisma migrations on test database...");
  execSync("npx prisma migrate deploy", {
    env: prismaEnv,
    stdio: "inherit",
  });

  // Teardown function to stop containers after tests
  return async () => {
    await pgContainer.stop();
    await redisContainer.stop();
  };
}
