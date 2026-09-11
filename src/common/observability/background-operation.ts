import { SpanStatusCode, trace } from "@opentelemetry/api";
import { captureException } from "../../sentry";

type ErrorSummary = Parameters<typeof captureException>[1]["message"];

type BackgroundFailureContext = {
  message: ErrorSummary;
  operation: string;
  source: "event" | "scheduler";
};

const tracer = trace.getTracer("hyre-worker-background");

function captureFailureOnSpan(
  span: ReturnType<typeof trace.getActiveSpan>,
  error: unknown,
  context: BackgroundFailureContext,
): void {
  span?.recordException({ name: "Error", message: context.message });
  span?.setStatus({ code: SpanStatusCode.ERROR, message: context.message });
  captureException(error, {
    message: context.message,
    tags: {
      "background.operation": context.operation,
      "error.source": context.source,
    },
  });
}

export function reportBackgroundFailure(error: unknown, context: BackgroundFailureContext): void {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) {
    tracer.startActiveSpan(
      context.operation,
      {
        attributes: { "background.operation": context.operation, "error.source": context.source },
      },
      (span) => {
        try {
          captureFailureOnSpan(span, error, context);
        } finally {
          span.end();
        }
      },
    );
    return;
  }

  captureFailureOnSpan(activeSpan, error, context);
}

export async function observeBackgroundOperation<T>(
  operation: string,
  source: BackgroundFailureContext["source"],
  handler: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    operation,
    {
      attributes: { "background.operation": operation, "error.source": source },
    },
    async (span) => {
      try {
        return await handler();
      } catch (error) {
        reportBackgroundFailure(error, {
          message: source === "scheduler" ? "Scheduled task failed" : "Event handler failed",
          operation,
          source,
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
