import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCaptureException, mockFlush, mockGetActiveSpan, mockInit, mockScope, mockWithScope } =
  vi.hoisted(() => {
    const mockScope = {
      setTags: vi.fn(),
      setContext: vi.fn(),
    };

    return {
      mockScope,
      mockInit: vi.fn(),
      mockCaptureException: vi.fn(),
      mockFlush: vi.fn().mockResolvedValue(true),
      mockGetActiveSpan: vi.fn(),
      mockWithScope: vi.fn((callback: (scope: typeof mockScope) => void) => callback(mockScope)),
    };
  });

vi.mock("@sentry/nestjs", () => ({
  init: mockInit,
  captureException: mockCaptureException,
  withScope: mockWithScope,
  flush: mockFlush,
}));

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getActiveSpan: mockGetActiveSpan,
  },
}));

const SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";

async function loadSentry() {
  vi.resetModules();
  return import("./sentry");
}

function expectErrorsOnlyInit(dsn: string | undefined, enabled: boolean) {
  expect(mockInit).toHaveBeenCalledWith(
    expect.objectContaining({
      dsn,
      enabled,
      defaultIntegrations: false,
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
    }),
  );
}

describe("sentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(undefined);
    vi.stubEnv("SENTRY_DSN", "");
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes Sentry disabled when SENTRY_DSN is absent", async () => {
    const { captureException } = await loadSentry();

    expectErrorsOnlyInit(undefined, false);

    captureException(new Error("secret token=abc"), {
      message: "HTTP request failed",
      tags: { "error.source": "http" },
    });

    expect(mockWithScope).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("initializes @sentry/nestjs with errors-only options when a DSN is set", async () => {
    vi.stubEnv("SENTRY_DSN", SENTRY_DSN);

    await loadSentry();

    expectErrorsOnlyInit(SENTRY_DSN, true);
  });

  it("sends a sanitized generic Error with safe tags and omits the original secret", async () => {
    vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
    const { captureException } = await loadSentry();
    const original = new Error("Card 4242 declined for user@example.com");
    original.stack = [
      "Error: Card 4242 declined for user@example.com",
      "    at Worker.process (/app/worker.js:10:5)",
    ].join("\n");

    captureException(original, {
      message: "BullMQ job failed",
      tags: {
        "error.source": "bullmq",
        "http.status_code": 500,
      },
    });

    expect(mockWithScope).toHaveBeenCalledTimes(1);
    expect(mockScope.setTags).toHaveBeenCalledWith({
      "error.source": "bullmq",
      "http.status_code": 500,
    });
    expect(mockScope.setContext).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    const sent = mockCaptureException.mock.calls[0]?.[0] as Error;
    expect(sent).toBeInstanceOf(Error);
    expect(sent).not.toBe(original);
    expect(sent.message).toBe("BullMQ job failed");
    expect(sent.stack).toContain("at Worker.process (/app/worker.js:10:5)");

    const payload = JSON.stringify({
      message: sent.message,
      stack: sent.stack,
      tags: mockScope.setTags.mock.calls,
    });
    expect(payload).not.toContain("4242");
    expect(payload).not.toContain("user@example.com");
    expect(payload).not.toContain(original.message);
  });

  it("attaches active OpenTelemetry trace and span IDs when a span is present", async () => {
    vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
    mockGetActiveSpan.mockReturnValue({
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      }),
    });
    const { captureException } = await loadSentry();

    captureException(new Error("db password rejected"), {
      message: "HTTP request failed",
      tags: { "error.source": "http" },
    });

    expect(mockScope.setContext).toHaveBeenCalledWith("opentelemetry", {
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
    });
    expect((mockCaptureException.mock.calls[0]?.[0] as Error).message).toBe("HTTP request failed");
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("db password rejected");
  });
});
