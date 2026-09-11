import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  captureExceptionMock,
  flushSentryMock,
  shutdownOpenTelemetryMock,
  registerUnhandledRejectionHandlerMock,
} = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  flushSentryMock: vi.fn().mockResolvedValue(true),
  shutdownOpenTelemetryMock: vi.fn().mockResolvedValue(undefined),
  registerUnhandledRejectionHandlerMock: vi.fn(),
}));

vi.mock("./sentry", () => ({
  captureException: captureExceptionMock,
  flushSentry: flushSentryMock,
  registerUnhandledRejectionHandler: registerUnhandledRejectionHandlerMock,
}));

vi.mock("./tracing", () => ({
  shutdownOpenTelemetry: shutdownOpenTelemetryMock,
}));

vi.mock("./app.module", () => ({
  AppModule: class AppModule {},
}));

vi.mock("./modules/auth/auth.service", () => ({
  AuthService: class AuthService {},
}));

vi.mock("./modules/auth/origin-pattern", () => ({
  isOriginAllowed: vi.fn(),
}));

vi.mock("@nestjs/core", () => ({
  NestFactory: {
    create: vi.fn(),
  },
}));

vi.mock("helmet", () => ({
  default: vi.fn(),
}));

describe("main bootstrap failure", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    flushSentryMock.mockResolvedValue(true);
    shutdownOpenTelemetryMock.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  async function importFailingBootstrap(error: Error) {
    const { NestFactory } = await import("@nestjs/core");
    vi.mocked(NestFactory.create).mockRejectedValue(error);
    await import("./main");
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  }

  it("flushes Sentry and shuts down OpenTelemetry before exiting", async () => {
    const error = new Error("listen failed");

    await importFailingBootstrap(error);

    expect(registerUnhandledRejectionHandlerMock).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      message: "Application bootstrap failed",
      tags: { "error.source": "bootstrap" },
    });
    expect(flushSentryMock).toHaveBeenCalledTimes(1);
    expect(shutdownOpenTelemetryMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(captureExceptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      flushSentryMock.mock.invocationCallOrder[0],
    );
    expect(flushSentryMock.mock.invocationCallOrder[0]).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0],
    );
    expect(shutdownOpenTelemetryMock.mock.invocationCallOrder[0]).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0],
    );
  });

  it("settles both telemetry shutdowns even when they reject", async () => {
    flushSentryMock.mockRejectedValueOnce(new Error("sentry flush failed"));
    shutdownOpenTelemetryMock.mockRejectedValueOnce(new Error("otel shutdown failed"));

    await importFailingBootstrap(new Error("listen failed"));

    expect(flushSentryMock).toHaveBeenCalledTimes(1);
    expect(shutdownOpenTelemetryMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
