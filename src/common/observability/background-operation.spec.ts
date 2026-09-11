import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeBackgroundOperation, reportBackgroundFailure } from "./background-operation";

const { captureExceptionMock, mockSpan, startActiveSpan, getActiveSpan, setActiveSpan } =
  vi.hoisted(() => {
    const mockSpan = {
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    let activeSpan: typeof mockSpan | undefined;

    return {
      captureExceptionMock: vi.fn(),
      mockSpan,
      getActiveSpan: () => activeSpan,
      setActiveSpan: (span: typeof mockSpan | undefined) => {
        activeSpan = span;
      },
      startActiveSpan: vi.fn(
        (_name: string, _options: unknown, fn: (span: typeof mockSpan) => unknown) => {
          const previous = activeSpan;
          activeSpan = mockSpan;
          const result = fn(mockSpan);
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).finally(() => {
              activeSpan = previous;
            });
          }
          activeSpan = previous;
          return result;
        },
      ),
    };
  });

vi.mock("../../sentry", () => ({
  captureException: captureExceptionMock,
}));

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: () => ({ startActiveSpan }),
      getActiveSpan,
    },
  };
});

describe("background-operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveSpan(undefined);
  });

  it("creates an active span and returns the handler result", async () => {
    const result = await observeBackgroundOperation(
      "StatusChangeScheduler.scheduleConfirmedToActiveUpdates",
      "scheduler",
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(startActiveSpan).toHaveBeenCalledWith(
      "StatusChangeScheduler.scheduleConfirmedToActiveUpdates",
      {
        attributes: {
          "background.operation": "StatusChangeScheduler.scheduleConfirmedToActiveUpdates",
          "error.source": "scheduler",
        },
      },
      expect.any(Function),
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("marks uncaught callback errors with generic diagnostics, captures once, and rethrows", async () => {
    const error = new Error("Card 4242 declined for user@example.com");

    await expect(
      observeBackgroundOperation(
        "StatusChangeEventsListener.onBookingConfirmed",
        "event",
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    expect(mockSpan.recordException).toHaveBeenCalledTimes(1);
    expect(mockSpan.recordException).toHaveBeenCalledWith({
      name: "Error",
      message: "Event handler failed",
    });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "Event handler failed",
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      message: "Event handler failed",
      tags: {
        "background.operation": "StatusChangeEventsListener.onBookingConfirmed",
        "error.source": "event",
      },
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);

    const recorded = JSON.stringify([
      mockSpan.recordException.mock.calls,
      mockSpan.setStatus.mock.calls,
      captureExceptionMock.mock.calls[0]?.[1],
    ]);
    expect(recorded).not.toContain("4242");
    expect(recorded).not.toContain("user@example.com");
  });

  it("reports swallowed errors without rethrowing and captures once", () => {
    const error = new Error("Queue error");

    expect(() =>
      reportBackgroundFailure(error, {
        message: "Failed to schedule status updates",
        operation: "StatusChangeScheduler.scheduleConfirmedToActiveUpdates",
        source: "scheduler",
      }),
    ).not.toThrow();

    expect(startActiveSpan).toHaveBeenCalledTimes(1);
    expect(mockSpan.recordException).toHaveBeenCalledWith({
      name: "Error",
      message: "Failed to schedule status updates",
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      message: "Failed to schedule status updates",
      tags: {
        "background.operation": "StatusChangeScheduler.scheduleConfirmedToActiveUpdates",
        "error.source": "scheduler",
      },
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("reuses an already-active span instead of starting another", () => {
    setActiveSpan(mockSpan);
    const error = new Error("provider unavailable");

    reportBackgroundFailure(error, {
      message: "Failed to reconcile processing payouts",
      operation: "PaymentReconciliationService.reconcileProcessingPayouts",
      source: "scheduler",
    });

    expect(startActiveSpan).not.toHaveBeenCalled();
    expect(mockSpan.end).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("records on the started span when getActiveSpan stays unset", () => {
    startActiveSpan.mockImplementationOnce(
      (_name: string, _options: unknown, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan),
    );
    const error = new Error("queue down");

    expect(() =>
      reportBackgroundFailure(error, {
        message: "Failed to schedule status updates",
        operation: "StatusChangeScheduler.scheduleConfirmedToActiveUpdates",
        source: "scheduler",
      }),
    ).not.toThrow();

    expect(startActiveSpan).toHaveBeenCalledTimes(1);
    expect(mockSpan.recordException).toHaveBeenCalledTimes(1);
    expect(mockSpan.recordException).toHaveBeenCalledWith({
      name: "Error",
      message: "Failed to schedule status updates",
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});
