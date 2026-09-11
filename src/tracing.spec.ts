import type { InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockNodeSDK,
  mockStart,
  mockOTLPTraceExporter,
  mockOTLPMetricExporter,
  mockPeriodicExportingMetricReader,
  mockBatchSpanProcessor,
  mockGetNodeAutoInstrumentations,
  sdkInstances,
} = vi.hoisted(() => {
  const start = vi.fn();
  const sdkInstances: Array<{ start: typeof start; shutdown: ReturnType<typeof vi.fn> }> = [];
  return {
    mockStart: start,
    sdkInstances,
    mockNodeSDK: vi.fn().mockImplementation(() => {
      const instance = {
        start,
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      sdkInstances.push(instance);
      return instance;
    }),
    mockOTLPTraceExporter: vi.fn(),
    mockOTLPMetricExporter: vi.fn(),
    mockPeriodicExportingMetricReader: vi.fn().mockImplementation((config) => config),
    mockBatchSpanProcessor: vi.fn().mockImplementation((exporter) => ({ exporter })),
    mockGetNodeAutoInstrumentations: vi.fn((_config?: InstrumentationConfigMap) => []),
  };
});

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: mockNodeSDK,
  metrics: {
    PeriodicExportingMetricReader: mockPeriodicExportingMetricReader,
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: mockOTLPTraceExporter,
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: mockOTLPMetricExporter,
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: mockBatchSpanProcessor,
}));

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
}));

const OTEL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
] as const;

async function loadTracing() {
  vi.resetModules();
  return import("./tracing");
}

function clearOtelEnv(): void {
  for (const key of OTEL_ENV_KEYS) {
    vi.stubEnv(key, "");
    delete process.env[key];
  }
}

describe("tracing bootstrap", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkInstances.length = 0;
    clearOtelEnv();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("does not start the SDK when no OTLP endpoint is configured", async () => {
    await loadTracing();

    expect(warnSpy).toHaveBeenCalledWith(
      "OpenTelemetry endpoint not set. Tracing and metrics disabled.",
    );
    expect(mockOTLPTraceExporter).not.toHaveBeenCalled();
    expect(mockOTLPMetricExporter).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts traces and metrics from a trailing-slash base endpoint", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otlp.example.com/otlp/");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20dGVzdA==");

    await loadTracing();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockOTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://otlp.example.com/otlp/v1/traces",
      headers: { Authorization: "Basic dGVzdA==" },
    });
    expect(mockOTLPMetricExporter).toHaveBeenCalledWith({
      url: "https://otlp.example.com/otlp/v1/metrics",
      headers: { Authorization: "Basic dGVzdA==" },
    });
    expect(mockPeriodicExportingMetricReader).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("prefers signal-specific trace and metric endpoints over the base endpoint", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otlp.example.com/otlp");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://tempo.example.com/v1/traces");
    vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "https://mimir.example.com/v1/metrics");

    await loadTracing();

    expect(mockOTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://tempo.example.com/v1/traces",
      headers: undefined,
    });
    expect(mockOTLPMetricExporter).toHaveBeenCalledWith({
      url: "https://mimir.example.com/v1/metrics",
      headers: undefined,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("starts traces without metrics when only a traces endpoint is set", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://tempo.example.com/v1/traces");

    await loadTracing();

    expect(mockOTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://tempo.example.com/v1/traces",
      headers: undefined,
    });
    expect(mockOTLPMetricExporter).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("starts the SDK without a trace exporter when only a metrics endpoint is set", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "https://mimir.example.com/v1/metrics");

    await loadTracing();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockOTLPTraceExporter).not.toHaveBeenCalled();
    expect(mockBatchSpanProcessor).not.toHaveBeenCalled();
    expect(mockOTLPMetricExporter).toHaveBeenCalledWith({
      url: "https://mimir.example.com/v1/metrics",
      headers: undefined,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("serializes ioredis statements as the command name without BullMQ arguments", async () => {
    await loadTracing();

    const serialize =
      mockGetNodeAutoInstrumentations.mock.calls[0]?.[0]?.["@opentelemetry/instrumentation-ioredis"]
        ?.dbStatementSerializer;

    expect(typeof serialize).toBe("function");
    if (typeof serialize !== "function") {
      throw new Error("expected ioredis dbStatementSerializer");
    }

    const statement = serialize("EVAL", [
      "local payload = cjson.decode(ARGV[1])",
      "1",
      "bull:notifications:wait",
      JSON.stringify({ email: "user@example.com", result: "secret-payload" }),
    ]);

    expect(statement).toBe("EVAL");
    expect(statement).not.toContain("user@example.com");
    expect(statement).not.toContain("secret-payload");
    expect(statement).not.toContain("bull:notifications");
  });

  it("does not start the SDK when only a logs endpoint is set", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://loki.example.com/v1/logs");

    await loadTracing();

    expect(warnSpy).toHaveBeenCalledWith(
      "OpenTelemetry endpoint not set. Tracing and metrics disabled.",
    );
    expect(mockOTLPTraceExporter).not.toHaveBeenCalled();
    expect(mockOTLPMetricExporter).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("does not shut down the SDK when telemetry is disabled", async () => {
    const { shutdownOpenTelemetry } = await loadTracing();

    await expect(shutdownOpenTelemetry()).resolves.toBeUndefined();
    expect(sdkInstances.at(-1)?.shutdown).not.toHaveBeenCalled();
  });

  it("shuts down the started SDK once", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://tempo.example.com/v1/traces");
    const { shutdownOpenTelemetry } = await loadTracing();

    await shutdownOpenTelemetry();
    await shutdownOpenTelemetry();

    expect(sdkInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("rejects shutdown after 2 seconds and keeps a late SDK completion on the same promise", async () => {
    vi.useFakeTimers();
    let finishShutdown: (() => void) | undefined;
    mockNodeSDK.mockImplementationOnce(() => {
      const instance = {
        start: mockStart,
        shutdown: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishShutdown = resolve;
            }),
        ),
      };
      sdkInstances.push(instance);
      return instance;
    });
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://tempo.example.com/v1/traces");
    const { shutdownOpenTelemetry } = await loadTracing();

    const first = shutdownOpenTelemetry();
    const timedOut = expect(first).rejects.toThrow("OpenTelemetry shutdown timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await timedOut;

    finishShutdown?.();
    await expect(shutdownOpenTelemetry()).rejects.toThrow("OpenTelemetry shutdown timed out");
    expect(sdkInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
