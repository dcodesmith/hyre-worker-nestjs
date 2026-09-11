import type * as Sentry from "@sentry/nestjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

const {
  mockCaptureException,
  mockFlush,
  mockGetActiveSpan,
  mockInit,
  mockScope,
  mockWithScope,
  mockDedupeIntegration,
  mockInboundFiltersIntegration,
  mockOnUncaughtExceptionIntegration,
  mockOnUnhandledRejectionIntegration,
  mockShutdownOpenTelemetry,
} = vi.hoisted(() => {
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
    mockDedupeIntegration: vi.fn(() => ({ name: "Dedupe" })),
    mockInboundFiltersIntegration: vi.fn(() => ({ name: "InboundFilters" })),
    mockOnUncaughtExceptionIntegration: vi.fn((options: unknown) => ({
      name: "OnUncaughtException",
      options,
    })),
    mockOnUnhandledRejectionIntegration: vi.fn((options: unknown) => ({
      name: "OnUnhandledRejection",
      options,
    })),
    mockShutdownOpenTelemetry: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@sentry/nestjs", () => ({
  init: mockInit,
  captureException: mockCaptureException,
  withScope: mockWithScope,
  flush: mockFlush,
  dedupeIntegration: mockDedupeIntegration,
  inboundFiltersIntegration: mockInboundFiltersIntegration,
  onUncaughtExceptionIntegration: mockOnUncaughtExceptionIntegration,
  onUnhandledRejectionIntegration: mockOnUnhandledRejectionIntegration,
}));

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getActiveSpan: mockGetActiveSpan,
    },
  };
});

vi.mock("./tracing", () => ({
  shutdownOpenTelemetry: mockShutdownOpenTelemetry,
}));

const SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
const VALID_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const VALID_SPAN_ID = "00f067aa0ba902b7";
const INVALID_TRACE_ID = "00000000000000000000000000000000";
const INVALID_SPAN_ID = "0000000000000000";

async function loadSentry() {
  vi.resetModules();
  return import("./sentry");
}

function getInitOptions(): SentryInitOptions {
  const options = mockInit.mock.calls.at(-1)?.[0] as SentryInitOptions | undefined;
  expect(options).toBeDefined();
  expect(options?.beforeSend).toEqual(expect.any(Function));
  return options as SentryInitOptions;
}

async function sanitizeOutgoing(
  event: Omit<Sentry.ErrorEvent, "type">,
  hint: Sentry.EventHint = {},
): Promise<Sentry.ErrorEvent | null | undefined> {
  return getInitOptions().beforeSend?.({ type: undefined, ...event }, hint);
}

function appPath(relative: string): string {
  return `${process.cwd().replaceAll("\\", "/")}/${relative}`;
}

function validSpanContext(overrides?: { traceId?: string; spanId?: string }) {
  return {
    spanContext: () => ({
      traceId: overrides?.traceId ?? VALID_TRACE_ID,
      spanId: overrides?.spanId ?? VALID_SPAN_ID,
      traceFlags: 1,
    }),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function grafanaExploreUrl(origin: string, traceId: string, timestampSeconds: number): string {
  const occurredAtMs = timestampSeconds * 1000;
  return `${origin}/explore?left=${encodeURIComponent(
    JSON.stringify({
      datasource: "grafanacloud-traces",
      queries: [{ query: traceId, queryType: "traceql", refId: "A" }],
      range: {
        from: new Date(occurredAtMs - 60 * 60 * 1000).toISOString(),
        to: new Date(occurredAtMs + 15 * 60 * 1000).toISOString(),
      },
    }),
  )}`;
}

describe("sentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(undefined);
    mockFlush.mockResolvedValue(true);
    mockShutdownOpenTelemetry.mockResolvedValue(undefined);
    vi.stubEnv("SENTRY_DSN", "");
    delete process.env.SENTRY_DSN;
    vi.stubEnv("GRAFANA_TRACES_BASE_URL", "");
    delete process.env.GRAFANA_TRACES_BASE_URL;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe("init", () => {
    it("initializes Sentry disabled without fatal integrations when SENTRY_DSN is absent", async () => {
      const { captureException } = await loadSentry();

      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: undefined,
          enabled: false,
          defaultIntegrations: false,
          skipOpenTelemetrySetup: true,
          tracesSampleRate: 0,
          sendDefaultPii: false,
          includeLocalVariables: false,
          maxBreadcrumbs: 0,
          integrations: [],
          dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            httpBodies: [],
            urlQueryParams: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            stackFrameVariables: false,
            frameContextLines: 0,
          },
        }),
      );
      expect(mockDedupeIntegration).not.toHaveBeenCalled();
      expect(mockOnUncaughtExceptionIntegration).not.toHaveBeenCalled();
      expect(mockOnUnhandledRejectionIntegration).not.toHaveBeenCalled();

      captureException(new Error("secret token=abc"), {
        message: "HTTP request failed",
        tags: { "error.source": "http" },
      });

      expect(mockWithScope).not.toHaveBeenCalled();
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("configures fatal integrations only when a DSN exists", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const { terminateAfterFatalError } = await loadSentry();

      expect(mockInit).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: SENTRY_DSN,
          enabled: true,
          defaultIntegrations: false,
        }),
      );
      expect(mockDedupeIntegration).not.toHaveBeenCalled();
      expect(mockInboundFiltersIntegration).not.toHaveBeenCalled();
      expect(mockOnUncaughtExceptionIntegration).toHaveBeenCalledWith({
        exitEvenIfOtherHandlersAreRegistered: true,
        onFatalError: terminateAfterFatalError,
      });
      expect(mockOnUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "none" });
    });
  });

  describe("captureException", () => {
    it("captures the original Error and stamps a generic summary tag", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const { captureException } = await loadSentry();
      const original = new Error("Card 4242 declined for user@example.com");

      captureException(original, {
        message: "HTTP request failed",
        tags: {
          "error.source": "http",
          "http.status_code": 500,
        },
      });

      expect(mockWithScope).toHaveBeenCalledTimes(1);
      expect(mockScope.setTags).toHaveBeenCalledWith({
        "error.source": "http",
        "http.status_code": 500,
        "error.summary": "HTTP request failed",
      });
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(original);
    });

    it("wraps non-Error values instead of sending the raw value", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const { captureException } = await loadSentry();

      captureException("secret token=abc", {
        message: "HTTP request failed",
        tags: { "error.source": "http" },
      });

      const sent = mockCaptureException.mock.calls.at(0)?.at(0);
      expect(sent).toBeInstanceOf(Error);
      expect(sent).toMatchObject({ message: "Non-Error exception" });
      expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("secret token=abc");
    });

    it("attaches valid active OpenTelemetry IDs as tags and context", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      mockGetActiveSpan.mockReturnValue(validSpanContext());
      const { captureException } = await loadSentry();

      captureException(new Error("db password rejected"), {
        message: "HTTP request failed",
        tags: { "error.source": "http" },
      });

      expect(mockScope.setTags).toHaveBeenCalledWith({
        "otel.trace_id": VALID_TRACE_ID,
        "otel.span_id": VALID_SPAN_ID,
      });
      expect(mockScope.setContext).toHaveBeenCalledWith("opentelemetry", {
        trace_id: VALID_TRACE_ID,
        span_id: VALID_SPAN_ID,
      });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it("ignores invalid active span contexts", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      mockGetActiveSpan.mockReturnValue(
        validSpanContext({ traceId: INVALID_TRACE_ID, spanId: INVALID_SPAN_ID }),
      );
      const { captureException } = await loadSentry();

      captureException(new Error("db password rejected"), {
        message: "HTTP request failed",
        tags: { "error.source": "http" },
      });

      expect(mockScope.setContext).not.toHaveBeenCalled();
      expect(mockScope.setTags).not.toHaveBeenCalledWith(
        expect.objectContaining({ "otel.trace_id": INVALID_TRACE_ID }),
      );
    });

    it("uses explicit trace context for queue-terminal captures", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      mockGetActiveSpan.mockReturnValue(
        validSpanContext({
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "bbbbbbbbbbbbbbbb",
        }),
      );
      const { captureException } = await loadSentry();
      const original = new Error("processor failed for user@example.com");

      captureException(original, {
        message: "BullMQ job exhausted retries",
        tags: {
          "error.source": "bullmq",
          "job.name": "send-notification",
          "queue.name": "notifications-queue",
        },
        traceContext: {
          traceId: VALID_TRACE_ID,
          spanId: VALID_SPAN_ID,
          traceFlags: 1,
        },
      });

      expect(mockCaptureException).toHaveBeenCalledWith(original);
      expect(mockScope.setTags).toHaveBeenCalledWith({
        "otel.trace_id": VALID_TRACE_ID,
        "otel.span_id": VALID_SPAN_ID,
      });
      expect(mockScope.setContext).toHaveBeenCalledWith("opentelemetry", {
        trace_id: VALID_TRACE_ID,
        span_id: VALID_SPAN_ID,
      });
      expect(JSON.stringify(mockScope.setTags.mock.calls)).not.toContain("user@example.com");
    });

    it("falls back to the active span when explicit trace context is invalid", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      mockGetActiveSpan.mockReturnValue(validSpanContext());
      const { captureException } = await loadSentry();

      captureException(new Error("queue secret"), {
        message: "BullMQ job exhausted retries",
        tags: { "error.source": "bullmq" },
        traceContext: {
          traceId: INVALID_TRACE_ID,
          spanId: INVALID_SPAN_ID,
          traceFlags: 1,
        },
      });

      expect(mockScope.setTags).toHaveBeenCalledWith({
        "otel.trace_id": VALID_TRACE_ID,
        "otel.span_id": VALID_SPAN_ID,
      });
      expect(mockScope.setContext).toHaveBeenCalledWith("opentelemetry", {
        trace_id: VALID_TRACE_ID,
        span_id: VALID_SPAN_ID,
      });
    });
  });

  describe("beforeSend", () => {
    it("replaces the exception value with a generic summary and drops sensitive event data", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();
      const original = new Error("Card 4242 declined for user@example.com");
      const sourceFile = appPath("src/modules/payment/payment.service.ts");

      const sanitized = await sanitizeOutgoing(
        {
          event_id: "abc123",
          timestamp: 1_700_000_000,
          level: "error",
          platform: "node",
          release: "local",
          environment: "test",
          message: original.message,
          request: { url: "https://api.example.com/charge?token=secret", cookies: { sid: "1" } },
          user: { email: "user@example.com", ip_address: "1.2.3.4" },
          extra: { card: "4242", payload: { token: "secret" } },
          breadcrumbs: [{ message: "token=secret" }],
          tags: {
            "error.summary": "HTTP request failed",
            "error.source": "http",
            "http.method": "POST",
            "http.status_code": 502,
            "error.code": "PROVIDER_FAILED",
            "user.email": "user@example.com",
            "card.last4": "4242",
          },
          contexts: {
            os: { name: "darwin" },
            runtime: { name: "node" },
            opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
            trace: { trace_id: "should-not-leak", span_id: VALID_SPAN_ID },
          },
          exception: {
            values: [
              {
                type: "Error",
                value: original.message,
                mechanism: {
                  type: "generic",
                  handled: true,
                  data: { secret: "token=abc" },
                },
                stacktrace: {
                  frames: [
                    {
                      filename: sourceFile,
                      function: "chargeCard",
                      module: "payment.service",
                      lineno: 42,
                      colno: 7,
                      in_app: true,
                      vars: { card: "4242", email: "user@example.com" },
                      context_line: "throw new Error('Card 4242 declined')",
                      pre_context: ["const pan = '4242';"],
                      post_context: ["return charge;"],
                      abs_path: sourceFile,
                    },
                  ],
                },
              },
            ],
          },
        },
        { originalException: original },
      );

      expect(sanitized).toMatchObject({
        type: undefined,
        event_id: "abc123",
        platform: "node",
        tags: {
          "error.summary": "HTTP request failed",
          "error.source": "http",
          "http.method": "POST",
          "http.status_code": 502,
        },
        contexts: {
          opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "HTTP request failed",
              mechanism: { type: "generic", handled: true },
              stacktrace: {
                frames: [
                  {
                    filename: "app:///src/modules/payment/payment.service.ts",
                    lineno: 42,
                    colno: 7,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        },
      });

      const payload = JSON.stringify(sanitized);
      expect(sanitized).not.toHaveProperty("message");
      expect(sanitized).not.toHaveProperty("request");
      expect(sanitized).not.toHaveProperty("user");
      expect(sanitized).not.toHaveProperty("extra");
      expect(sanitized).not.toHaveProperty("breadcrumbs");
      expect((sanitized as { tags: Record<string, unknown> }).tags).not.toHaveProperty(
        "error.code",
      );
      expect(payload).not.toContain("4242");
      expect(payload).not.toContain("user@example.com");
      expect(payload).not.toContain("token=secret");
      expect(payload).not.toContain("chargeCard");
      expect(payload).not.toContain(sourceFile);
      expect(
        (sanitized as { exception: { values: Array<{ stacktrace: { frames: unknown[] } }> } })
          .exception.values[0].stacktrace.frames[0],
      ).not.toHaveProperty("function");
      expect(
        (sanitized as { exception: { values: Array<{ stacktrace: { frames: unknown[] } }> } })
          .exception.values[0].stacktrace.frames[0],
      ).not.toHaveProperty("vars");
      expect(
        (sanitized as { exception: { values: Array<{ stacktrace: { frames: unknown[] } }> } })
          .exception.values[0].stacktrace.frames[0],
      ).not.toHaveProperty("context_line");
    });

    it("rewrites in-app, node_modules, file URL, and node: frames while dropping unsafe paths", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();
      const original = new Error("failed");

      const sanitized = (await sanitizeOutgoing(
        {
          exception: {
            values: [
              {
                type: "TypeError",
                value: original.message,
                stacktrace: {
                  frames: [
                    {
                      filename: "node:internal/process/task_queues",
                      function: "processTicksAndRejections",
                      lineno: 95,
                      colno: 5,
                      in_app: true,
                    },
                    {
                      filename: `file://${appPath("src/sentry.ts")}`,
                      function: "captureException",
                      lineno: 12,
                      colno: 3,
                    },
                    {
                      filename: appPath("src/node_modules/@sentry/core/index.js"),
                      function: "withScope",
                      lineno: 8,
                      colno: 1,
                    },
                    {
                      filename: `${process.cwd().replaceAll("\\", "/")}/../secret.ts`,
                      function: "leak",
                      lineno: 1,
                      colno: 1,
                    },
                    {
                      filename: "/etc/passwd",
                      function: "outside",
                      lineno: 1,
                      colno: 1,
                    },
                    {
                      filename: `${appPath("src/sentry.ts")}?token=secret`,
                      function: "query",
                      lineno: 4,
                      colno: 1,
                    },
                    {
                      filename: appPath("src/missing-line.ts"),
                      function: "noLine",
                    },
                  ],
                },
              },
            ],
          },
        },
        { originalException: original },
      )) as {
        exception: {
          values: Array<{
            type: string;
            stacktrace: { frames: Array<{ filename: string; in_app: boolean }> };
          }>;
        };
      };

      expect(sanitized.exception.values[0].type).toBe("TypeError");
      expect(sanitized.exception.values[0].stacktrace.frames).toEqual([
        {
          filename: "node:internal/process/task_queues",
          lineno: 95,
          colno: 5,
          in_app: false,
        },
        {
          filename: "app:///src/sentry.ts",
          lineno: 12,
          colno: 3,
          in_app: true,
        },
        {
          filename: "app:///src/node_modules/@sentry/core/index.js",
          lineno: 8,
          colno: 1,
          in_app: false,
        },
      ]);
    });

    it("drops stack frames injected through the original error message", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();
      const injectedPath = appPath("src/secret.ts");
      const original = new Error(`failed\n    at ${injectedPath}:10:5`);

      const sanitized = (await sanitizeOutgoing(
        {
          exception: {
            values: [
              {
                type: "Error",
                value: original.message,
                stacktrace: {
                  frames: [
                    {
                      filename: injectedPath,
                      function: "attack",
                      lineno: 10,
                      colno: 5,
                    },
                    {
                      filename: appPath("src/sentry.ts"),
                      function: "realFrame",
                      lineno: 20,
                      colno: 1,
                    },
                  ],
                },
              },
            ],
          },
        },
        { originalException: original },
      )) as {
        exception: { values: Array<{ stacktrace: { frames: Array<{ filename: string }> } }> };
      };

      expect(sanitized.exception.values[0].stacktrace.frames).toEqual([
        {
          filename: "app:///src/sentry.ts",
          lineno: 20,
          colno: 1,
          in_app: true,
        },
      ]);
    });

    it("falls back to unhandled-rejection and uncaught-exception summaries", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();

      const rejection = (await sanitizeOutgoing(
        {
          tags: { "error.summary": "not-allowlisted" },
          exception: {
            values: [
              {
                type: "Error",
                value: "secret boom",
                mechanism: { type: "auto.node.onunhandledrejection", handled: false },
              },
            ],
          },
        },
        { originalException: new Error("secret boom") },
      )) as { exception: { values: Array<{ value: string; mechanism: { type: string } }> } };

      expect(rejection.exception.values[0].value).toBe("Unhandled promise rejection");
      expect(rejection.exception.values[0].mechanism).toEqual({
        type: "auto.node.onunhandledrejection",
        handled: false,
      });

      const uncaught = (await sanitizeOutgoing(
        {
          exception: {
            values: [{ type: "Error", value: "secret boom" }],
          },
        },
        { originalException: new Error("secret boom") },
      )) as { exception: { values: Array<{ value: string }> } };

      expect(uncaught.exception.values[0].value).toBe("Uncaught exception");

      const removedBullMqSummary = (await sanitizeOutgoing(
        {
          tags: { "error.summary": "BullMQ job failed" },
          exception: {
            values: [{ type: "Error", value: "secret boom" }],
          },
        },
        { originalException: new Error("secret boom") },
      )) as { exception: { values: Array<{ value: string }> } };

      expect(removedBullMqSummary.exception.values[0].value).toBe("Uncaught exception");
    });

    it("attaches active OpenTelemetry IDs in beforeSend when event context is missing", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      mockGetActiveSpan.mockReturnValue(validSpanContext());
      await loadSentry();

      const sanitized = await sanitizeOutgoing(
        {
          tags: { "error.summary": "HTTP request failed", "error.source": "http" },
          exception: {
            values: [{ type: "Error", value: "secret boom" }],
          },
        },
        { originalException: new Error("secret boom") },
      );

      expect(sanitized?.tags).toMatchObject({
        "error.summary": "HTTP request failed",
        "error.source": "http",
        "otel.trace_id": VALID_TRACE_ID,
        "otel.span_id": VALID_SPAN_ID,
      });
      expect(sanitized?.contexts).toEqual({
        opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
      });
    });

    it("keeps allowlisted job and background tags while dropping unknown keys", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();

      const sanitized = (await sanitizeOutgoing(
        {
          tags: {
            "error.summary": "BullMQ job exhausted retries",
            "error.source": "bullmq",
            "job.name": "send-notification",
            "queue.name": "notifications-queue",
            "background.operation": "StatusChangeEventsListener.onBookingConfirmed",
            "booking.id": "booking-secret",
          },
          exception: {
            values: [{ type: "Error", value: "secret" }],
          },
        },
        { originalException: new Error("secret") },
      )) as { tags: Record<string, unknown> };

      expect(sanitized.tags).toEqual({
        "error.summary": "BullMQ job exhausted retries",
        "error.source": "bullmq",
        "job.name": "send-notification",
        "queue.name": "notifications-queue",
        "background.operation": "StatusChangeEventsListener.onBookingConfirmed",
      });
    });

    it("drops invalid OpenTelemetry context and unknown exception types", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();

      const sanitized = (await sanitizeOutgoing(
        {
          tags: {
            "otel.trace_id": "not-a-trace",
            "otel.span_id": VALID_SPAN_ID,
            "http.status_code": 404,
            "error.source": "queue",
          },
          contexts: {
            opentelemetry: { trace_id: "not-hex", span_id: VALID_SPAN_ID },
          },
          exception: {
            values: [
              {
                type: "not a type",
                value: "secret",
                mechanism: { type: "onerror", handled: true },
              },
            ],
          },
        },
        { originalException: new Error("secret") },
      )) as {
        tags: Record<string, unknown>;
        exception: { values: Array<{ type: string; mechanism?: unknown }> };
      };

      expect(sanitized.tags).toEqual({});
      expect(sanitized).not.toHaveProperty("contexts");
      expect(sanitized.exception.values[0].type).toBe("Error");
      expect(sanitized.exception.values[0]).not.toHaveProperty("mechanism");
    });

    it("drops tags-only OpenTelemetry IDs and falls back to the active span for invalid event context", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();

      const tagsOnly = (await sanitizeOutgoing(
        {
          tags: {
            "otel.trace_id": VALID_TRACE_ID,
            "otel.span_id": VALID_SPAN_ID,
            "error.source": "http",
          },
          exception: {
            values: [{ type: "Error", value: "secret" }],
          },
        },
        { originalException: new Error("secret") },
      )) as { tags: Record<string, unknown> };

      expect(tagsOnly.tags).toEqual({ "error.source": "http" });
      expect(tagsOnly).not.toHaveProperty("contexts");

      mockGetActiveSpan.mockReturnValue(validSpanContext());
      const fallback = await sanitizeOutgoing(
        {
          tags: {
            "otel.trace_id": VALID_TRACE_ID,
            "otel.span_id": "not-a-span",
            "error.source": "http",
          },
          contexts: {
            opentelemetry: { trace_id: "not-hex", span_id: VALID_SPAN_ID },
          },
          exception: {
            values: [{ type: "Error", value: "secret" }],
          },
        },
        { originalException: new Error("secret") },
      );

      expect(fallback?.tags).toEqual({
        "error.source": "http",
        "otel.trace_id": VALID_TRACE_ID,
        "otel.span_id": VALID_SPAN_ID,
      });
      expect(fallback?.contexts).toEqual({
        opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
      });
    });

    it("adds a Grafana Tempo explore link from a valid https origin and paired OTel IDs", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();
      vi.stubEnv(
        "GRAFANA_TRACES_BASE_URL",
        "https://gallantcricket1373.grafana.net/extra?tab=traces",
      );

      const timestamp = 1_700_000_000;
      const sanitized = await sanitizeOutgoing(
        {
          timestamp,
          tags: { "error.summary": "HTTP request failed", "error.source": "http" },
          extra: { token: "secret" },
          user: { email: "user@example.com" },
          request: { url: "https://api.example.com/charge?token=secret" },
          breadcrumbs: [{ message: "token=secret" }],
          contexts: {
            opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
          },
          exception: {
            values: [{ type: "Error", value: "secret boom" }],
          },
        },
        { originalException: new Error("secret boom") },
      );

      expect(sanitized).not.toHaveProperty("extra");
      expect(sanitized).not.toHaveProperty("user");
      expect(sanitized).not.toHaveProperty("request");
      expect(sanitized).not.toHaveProperty("breadcrumbs");
      expect(sanitized?.tags).toMatchObject({
        "otel.trace_id": VALID_TRACE_ID,
        "otel.span_id": VALID_SPAN_ID,
      });
      expect(sanitized?.contexts).toEqual({
        opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
        grafana: {
          "View trace": grafanaExploreUrl(
            "https://gallantcricket1373.grafana.net",
            VALID_TRACE_ID,
            timestamp,
          ),
        },
      });
    });

    it.each([
      { label: "unset", value: undefined },
      { label: "blank", value: "" },
      { label: "http origin", value: "http://gallantcricket1373.grafana.net" },
      { label: "non-URL", value: "not-a-url" },
    ])("omits contexts.grafana when GRAFANA_TRACES_BASE_URL is $label", async ({ value }) => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      await loadSentry();
      if (value === undefined) {
        delete process.env.GRAFANA_TRACES_BASE_URL;
      } else {
        vi.stubEnv("GRAFANA_TRACES_BASE_URL", value);
      }

      const sanitized = await sanitizeOutgoing(
        {
          tags: { "error.summary": "HTTP request failed", "error.source": "http" },
          contexts: {
            opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
          },
          exception: {
            values: [{ type: "Error", value: "secret boom" }],
          },
        },
        { originalException: new Error("secret boom") },
      );

      expect(sanitized?.contexts).toEqual({
        opentelemetry: { trace_id: VALID_TRACE_ID, span_id: VALID_SPAN_ID },
      });
      expect(sanitized?.contexts).not.toHaveProperty("grafana");
    });
  });

  describe("flush and fatal shutdown", () => {
    it("flushSentry is a no-op without a DSN and forwards the timeout when enabled", async () => {
      const disabled = await loadSentry();
      await expect(disabled.flushSentry()).resolves.toBe(true);
      expect(mockFlush).not.toHaveBeenCalled();

      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const enabled = await loadSentry();
      await expect(enabled.flushSentry(5_000)).resolves.toBe(true);
      expect(mockFlush).toHaveBeenCalledWith(5_000);
    });

    it("registers unhandledRejection and uncaughtException without a DSN", async () => {
      const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
      const { registerUnhandledRejectionHandler, terminateAfterFatalError } = await loadSentry();

      registerUnhandledRejectionHandler();
      registerUnhandledRejectionHandler();

      expect(onSpy).toHaveBeenCalledTimes(2);
      expect(onSpy).toHaveBeenCalledWith("unhandledRejection", terminateAfterFatalError);
      expect(onSpy).toHaveBeenCalledWith("uncaughtException", terminateAfterFatalError);
      onSpy.mockRestore();
    });

    it("registers only unhandledRejection when a DSN exists", async () => {
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
      const { registerUnhandledRejectionHandler, terminateAfterFatalError } = await loadSentry();

      registerUnhandledRejectionHandler();
      registerUnhandledRejectionHandler();

      expect(onSpy).toHaveBeenCalledTimes(1);
      expect(onSpy).toHaveBeenCalledWith("unhandledRejection", terminateAfterFatalError);
      expect(onSpy).not.toHaveBeenCalledWith("uncaughtException", terminateAfterFatalError);
      onSpy.mockRestore();
    });

    it("flushes Sentry and OpenTelemetry before exiting after a fatal error", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const { terminateAfterFatalError } = await loadSentry();

      terminateAfterFatalError();
      terminateAfterFatalError();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

      expect(mockFlush).toHaveBeenCalledTimes(1);
      expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      exitSpy.mockRestore();
    });

    it("still exits when flush or shutdown rejects", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      mockFlush.mockRejectedValueOnce(new Error("sentry unavailable"));
      mockShutdownOpenTelemetry.mockRejectedValueOnce(new Error("otel unavailable"));
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const { terminateAfterFatalError } = await loadSentry();

      terminateAfterFatalError();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      exitSpy.mockRestore();
    });

    it("force-exits if telemetry flush hangs", async () => {
      vi.useFakeTimers();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      mockFlush.mockImplementation(() => new Promise(() => {}));
      mockShutdownOpenTelemetry.mockImplementation(() => new Promise(() => {}));
      vi.stubEnv("SENTRY_DSN", SENTRY_DSN);
      const { terminateAfterFatalError } = await loadSentry();

      terminateAfterFatalError();
      await flushMicrotasks();
      expect(exitSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_500);
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });
});
