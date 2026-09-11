import { getSharedConfigToken } from "@nestjs/bullmq";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import type { QueueOptions } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBullMqTelemetry } from "./bullmq-telemetry";
import { QueueInfraModule } from "./queue-infra.module";

const { createBullMqTelemetryMock } = vi.hoisted(() => ({
  createBullMqTelemetryMock: vi.fn((name: string, version: string) => ({
    name,
    version,
    tracer: { startSpan: vi.fn() },
    contextManager: { active: vi.fn() },
    meter: { createCounter: vi.fn() },
  })),
}));

vi.mock("./bullmq-telemetry", () => ({
  createBullMqTelemetry: createBullMqTelemetryMock,
}));

async function compileQueueInfra(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
      }),
      QueueInfraModule,
    ],
  }).compile();
}

describe("QueueInfraModule telemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("creates one shared telemetry config with the configured service name and version", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("OTEL_SERVICE_NAME", "hyre-worker-test");
    vi.stubEnv("DEPLOYMENT_VERSION", "9.9.9");

    const module = await compileQueueInfra();

    try {
      expect(createBullMqTelemetry).toHaveBeenCalledTimes(1);
      expect(createBullMqTelemetry).toHaveBeenCalledWith("hyre-worker-test", "9.9.9");

      const sharedConfig = module.get<QueueOptions>(getSharedConfigToken());
      expect(sharedConfig.telemetry).toBe(createBullMqTelemetryMock.mock.results[0]?.value);
      expect(sharedConfig.telemetry?.meter).toBeDefined();
    } finally {
      await module.close();
    }
  });

  it("falls back to hyre-worker-nestjs when OTEL_SERVICE_NAME is unset", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("OTEL_SERVICE_NAME", "");
    vi.stubEnv("DEPLOYMENT_VERSION", "local");

    const module = await compileQueueInfra();

    try {
      expect(createBullMqTelemetry).toHaveBeenCalledTimes(1);
      expect(createBullMqTelemetry).toHaveBeenCalledWith("hyre-worker-nestjs", "local");
      expect(module.get<QueueOptions>(getSharedConfigToken()).telemetry).toBe(
        createBullMqTelemetryMock.mock.results[0]?.value,
      );
    } finally {
      await module.close();
    }
  });
});
