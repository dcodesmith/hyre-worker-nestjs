import { Test, type TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { flushSentry } from "../../../sentry";
import { shutdownOpenTelemetry } from "../../../tracing";
import { TelemetryLifecycleService } from "./telemetry-lifecycle.service";

const { flushSentryMock, shutdownOpenTelemetryMock } = vi.hoisted(() => ({
  flushSentryMock: vi.fn().mockResolvedValue(true),
  shutdownOpenTelemetryMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../sentry", () => ({
  flushSentry: flushSentryMock,
}));

vi.mock("../../../tracing", () => ({
  shutdownOpenTelemetry: shutdownOpenTelemetryMock,
}));

describe("TelemetryLifecycleService", () => {
  let service: TelemetryLifecycleService;
  let logger: PinoLogger;

  beforeEach(async () => {
    vi.clearAllMocks();
    flushSentryMock.mockResolvedValue(true);
    shutdownOpenTelemetryMock.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [TelemetryLifecycleService],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(TelemetryLifecycleService);
    logger = module.get(PinoLogger);
  });

  it("flushes Sentry and shuts down OpenTelemetry on Nest shutdown", async () => {
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();

    expect(flushSentry).toHaveBeenCalledTimes(1);
    expect(shutdownOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs rejected flushes without throwing", async () => {
    flushSentryMock.mockRejectedValueOnce(new Error("sentry unavailable"));
    shutdownOpenTelemetryMock.mockRejectedValueOnce(new Error("otel unavailable"));

    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();

    expect(flushSentry).toHaveBeenCalledTimes(1);
    expect(shutdownOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("Failed to flush Sentry during shutdown");
    expect(logger.error).toHaveBeenCalledWith("Failed to shut down OpenTelemetry during shutdown");
  });
});
