import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockNodeSDK,
  mockStart,
  mockOTLPTraceExporter,
  mockOTLPMetricExporter,
  mockPeriodicExportingMetricReader,
  mockBatchSpanProcessor,
} = vi.hoisted(() => {
  const start = vi.fn();
  return {
    mockStart: start,
    mockNodeSDK: vi.fn().mockImplementation(() => ({
      start,
      shutdown: vi.fn(),
    })),
    mockOTLPTraceExporter: vi.fn(),
    mockOTLPMetricExporter: vi.fn(),
    mockPeriodicExportingMetricReader: vi.fn().mockImplementation((config) => config),
    mockBatchSpanProcessor: vi.fn().mockImplementation((exporter) => ({ exporter })),
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
  getNodeAutoInstrumentations: vi.fn(() => []),
}));

const OTEL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
] as const;

async function loadTracing(): Promise<void> {
  vi.resetModules();
  await import("./tracing");
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
    clearOtelEnv();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
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
});
