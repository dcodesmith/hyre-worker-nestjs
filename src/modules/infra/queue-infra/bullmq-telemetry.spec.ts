import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { Exception } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../../../sentry";
import { createBullMqTelemetry } from "./bullmq-telemetry";

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

  it("captures processing exceptions in Sentry and still exports a generic OTel exception", () => {
    const span = startSafeSpan();
    const error = new Error("Card 4242 declined for user@example.com");
    const recordedAt = 1_700_000_000_000;

    span.recordException(error, recordedAt);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      message: "BullMQ job failed",
      tags: { "error.source": "bullmq" },
    });
    expect(innerSpan.recordException).toHaveBeenCalledTimes(1);
    expect(innerSpan.recordException).toHaveBeenCalledWith(
      { name: "Error", message: "BullMQ job failed" },
      recordedAt,
    );
    expect(JSON.stringify(innerSpan.recordException.mock.calls)).not.toContain("4242");
  });

  it("does not capture producer exceptions in Sentry", () => {
    const span = createBullMqTelemetry("hyre-worker-test", "1.2.3").tracer.startSpan(
      "add orders.probe",
    );
    const error = new Error("queue connection secret");

    span.recordException(error);

    expect(captureException).not.toHaveBeenCalled();
    expect(innerSpan.recordException).toHaveBeenCalledTimes(1);
    expect(innerSpan.recordException).toHaveBeenCalledWith(
      { name: "Error", message: "BullMQ job failed" },
      undefined,
    );
  });
});
