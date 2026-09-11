import { ROOT_CONTEXT } from "@opentelemetry/api";
import { type Exception, type Job, UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../../../sentry";
import { captureTerminalJobFailure, createBullMqTelemetry } from "./bullmq-telemetry";

const { extractMock, getSpanContextMock } = vi.hoisted(() => ({
  extractMock: vi.fn(),
  getSpanContextMock: vi.fn(),
}));

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...actual,
    propagation: {
      ...actual.propagation,
      extract: extractMock,
    },
    trace: {
      ...actual.trace,
      getSpanContext: getSpanContextMock,
    },
  };
});

const SENSITIVE_KEYS = [
  "bullmq.job.result",
  "bullmq.job.failed.reason",
  "bullmq.job.progress",
] as const;

const { innerSpan, adapter, BullMQOtel } = vi.hoisted(() => {
  const innerSpan = {
    setSpanOnContext: vi.fn((context: unknown) => context),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };

  const adapter = {
    tracer: {
      startSpan: vi.fn(() => innerSpan),
    },
    contextManager: {
      active: vi.fn(() => ({})),
      with: vi.fn((_context: unknown, fn: () => unknown) => fn()),
      getMetadata: vi.fn(() => "{}"),
      fromMetadata: vi.fn(),
    },
    meter: {
      createCounter: vi.fn(),
      createHistogram: vi.fn(),
    },
  };

  return {
    innerSpan,
    adapter,
    BullMQOtel: vi.fn(function MockBullMQOtel() {
      return adapter;
    }),
  };
});

vi.mock("bullmq-otel", () => ({
  BullMQOtel,
}));

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("../../../sentry", () => ({
  captureException: captureExceptionMock,
}));

function startSafeSpan() {
  return createBullMqTelemetry("hyre-worker-test", "1.2.3").tracer.startSpan("process orders", {
    kind: 4,
  });
}

describe("createBullMqTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables the official adapter metrics and delegates context, meter, and span lifecycle", () => {
    const telemetry = createBullMqTelemetry("hyre-worker-test", "1.2.3");
    const context = ROOT_CONTEXT;

    expect(BullMQOtel).toHaveBeenCalledWith({
      tracerName: "hyre-worker-test",
      meterName: "hyre-worker-test",
      version: "1.2.3",
      enableMetrics: true,
    });
    expect(telemetry.contextManager).toBe(adapter.contextManager);
    expect(telemetry.meter).toBe(adapter.meter);
    expect(telemetry.tracer).not.toBe(adapter.tracer);

    const span = telemetry.tracer.startSpan("add orders.probe", { kind: 3 }, context);

    expect(adapter.tracer.startSpan).toHaveBeenCalledWith("add orders.probe", { kind: 3 }, context);
    expect(span).not.toBe(innerSpan);
    expect(span.setSpanOnContext(context)).toBe(context);
    expect(innerSpan.setSpanOnContext).toHaveBeenCalledWith(context);

    span.end();
    expect(innerSpan.end).toHaveBeenCalledTimes(1);
  });

  it.each(SENSITIVE_KEYS)("does not set %s individually", (key) => {
    startSafeSpan().setAttribute(key, "secret-value");

    expect(innerSpan.setAttribute).not.toHaveBeenCalled();
  });

  it("forwards non-sensitive span attributes", () => {
    startSafeSpan().setAttribute("bullmq.job.id", "job-1");

    expect(innerSpan.setAttribute).toHaveBeenCalledWith("bullmq.job.id", "job-1");
  });

  it("strips sensitive keys from setAttributes while keeping neighboring fields", () => {
    startSafeSpan().setAttributes({
      "bullmq.job.id": "job-1",
      "bullmq.job.result": "return-value-secret",
      "bullmq.job.failed.reason": "boom-secret",
      "bullmq.job.progress": 42,
      "bullmq.job.results": "keep-similar-key",
      "bullmq.queue.name": "orders",
    });

    expect(innerSpan.setAttributes).toHaveBeenCalledWith({
      "bullmq.job.id": "job-1",
      "bullmq.job.results": "keep-similar-key",
      "bullmq.queue.name": "orders",
    });
  });

  it("strips sensitive keys from event attributes and still forwards the event name", () => {
    const span = startSafeSpan();

    span.addEvent("job completed", {
      "bullmq.job.result": '{"email":"user@example.com"}',
      "bullmq.job.failed.reason": "processor exploded",
      "bullmq.job.progress": 100,
      "bullmq.job.id": "job-1",
    });
    span.addEvent("job started");

    expect(innerSpan.addEvent).toHaveBeenNthCalledWith(1, "job completed", {
      "bullmq.job.id": "job-1",
    });
    expect(innerSpan.addEvent).toHaveBeenNthCalledWith(2, "job started", undefined);
  });

  it("records exceptions generically without the original message or stack", () => {
    const span = startSafeSpan();
    const error = new Error("Card 4242 declined for user@example.com");
    error.stack = "Error: Card 4242 declined for user@example.com\n    at Worker.process";
    const exceptionObject: Exception = {
      name: "JobError",
      message: "Card 4242 declined for user@example.com",
      stack: "Error: Card 4242 declined\n    at Worker.process",
    };
    const recordedAt = 1_700_000_000_000;

    span.recordException(error, recordedAt);
    span.recordException("Card 4242 declined for user@example.com");
    span.recordException(exceptionObject);

    expect(innerSpan.recordException).toHaveBeenCalledTimes(3);
    expect(innerSpan.recordException).toHaveBeenNthCalledWith(
      1,
      { name: "Error", message: "BullMQ job failed" },
      recordedAt,
    );
    expect(innerSpan.recordException).toHaveBeenNthCalledWith(
      2,
      { name: "Error", message: "BullMQ job failed" },
      undefined,
    );
    expect(innerSpan.recordException).toHaveBeenNthCalledWith(
      3,
      { name: "Error", message: "BullMQ job failed" },
      undefined,
    );

    const recorded = JSON.stringify(innerSpan.recordException.mock.calls);
    expect(recorded).not.toContain("4242");
    expect(recorded).not.toContain("user@example.com");
    expect(recorded).not.toContain("Worker.process");
    expect(recorded).not.toContain("JobError");
  });

  it("does not capture Sentry events from the span wrapper on processing or producer failures", () => {
    const processSpan = startSafeSpan();
    const producerSpan = createBullMqTelemetry("hyre-worker-test", "1.2.3").tracer.startSpan(
      "add orders.probe",
    );
    const error = new Error("Card 4242 declined for user@example.com");

    processSpan.recordException(error, 1_700_000_000_000);
    producerSpan.recordException(error);

    expect(captureException).not.toHaveBeenCalled();
    expect(innerSpan.recordException).toHaveBeenCalledTimes(2);
  });
});

const TRACE_CARRIER = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
const EXTRACTED_SPAN_CONTEXT = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
};

function createJob(overrides?: {
  name?: string;
  attemptsMade?: number;
  attempts?: number | undefined;
  metadata?: string;
  data?: unknown;
  finishedOn?: number;
}): Job {
  return {
    name: overrides?.name ?? "send-notification",
    data: overrides?.data ?? { email: "user@example.com", token: "secret-payload" },
    attemptsMade: overrides?.attemptsMade ?? 1,
    finishedOn: overrides?.finishedOn,
    opts: {
      attempts: overrides?.attempts,
      telemetry: overrides?.metadata ? { metadata: overrides.metadata } : undefined,
    },
  } as Job;
}

describe("captureTerminalJobFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractMock.mockReturnValue({ spanContext: EXTRACTED_SPAN_CONTEXT });
    getSpanContextMock.mockImplementation((context) => context?.spanContext);
  });

  it("does not capture while retries remain", () => {
    const error = new Error("Card 4242 declined for user@example.com");

    captureTerminalJobFailure(
      createJob({ attemptsMade: 1, attempts: 3 }),
      error,
      "notifications-queue",
    );

    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures once retries are exhausted without exposing job payload details", () => {
    const error = new Error("Card 4242 declined for user@example.com");

    captureTerminalJobFailure(
      createJob({
        attemptsMade: 3,
        attempts: 3,
        data: { email: "user@example.com", token: "secret-payload" },
      }),
      error,
      "notifications-queue",
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      message: "BullMQ job failed terminally",
      tags: {
        "error.source": "bullmq",
        "job.name": "send-notification",
        "queue.name": "notifications-queue",
      },
      traceContext: undefined,
    });

    const captured = JSON.stringify(captureExceptionMock.mock.calls[0]?.[1]);
    expect(captured).not.toContain("user@example.com");
    expect(captured).not.toContain("secret-payload");
    expect(captured).not.toContain("4242");
  });

  it("captures a missing job as a generic no-context failure", () => {
    const error = new Error("job lost");

    captureTerminalJobFailure(undefined, error, "flight-alerts-queue");

    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      message: "BullMQ job failed without context",
      tags: { "error.source": "bullmq", "queue.name": "flight-alerts-queue" },
    });
  });

  it("treats missing attempts as a single try", () => {
    const error = new Error("boom");

    captureTerminalJobFailure(
      createJob({ attemptsMade: 1, attempts: undefined }),
      error,
      "reminders-queue",
    );

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("captures UnrecoverableError before retries are exhausted", () => {
    const error = new UnrecoverableError("Airport completion token state is invalid");

    captureTerminalJobFailure(
      createJob({ attemptsMade: 1, attempts: 3 }),
      error,
      "notifications-queue",
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ message: "BullMQ job failed terminally" }),
    );
  });

  it("captures a finished job even when retries remain", () => {
    captureTerminalJobFailure(
      createJob({ attemptsMade: 1, attempts: 3, finishedOn: Date.now() }),
      new Error("discarded after backoff -1"),
      "notifications-queue",
    );

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("extracts producer trace context from job metadata", () => {
    const error = new Error("terminal failure");

    captureTerminalJobFailure(
      createJob({
        attemptsMade: 1,
        attempts: 1,
        metadata: JSON.stringify(TRACE_CARRIER),
      }),
      error,
      "status-updates-queue",
    );

    expect(extractMock).toHaveBeenCalledWith(expect.anything(), TRACE_CARRIER);
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        traceContext: EXTRACTED_SPAN_CONTEXT,
      }),
    );
  });

  it.each([
    { label: "missing metadata", metadata: undefined },
    { label: "invalid json", metadata: "{not-json" },
    { label: "non-object carrier", metadata: JSON.stringify(["traceparent"]) },
  ])("ignores $label", ({ metadata }) => {
    captureTerminalJobFailure(
      createJob({ attemptsMade: 1, attempts: 1, metadata }),
      new Error("boom"),
      "reminders-queue",
    );

    expect(extractMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ traceContext: undefined }),
    );
  });
});
