import { trace } from "@opentelemetry/api";
import * as Sentry from "@sentry/nestjs";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
  release: process.env.DEPLOYMENT_VERSION || "local",
  defaultIntegrations: false,
  skipOpenTelemetrySetup: true,
  tracesSampleRate: 0,
});

type CaptureContext = {
  message: string;
  tags?: Record<string, string | number | boolean>;
};

export function captureException(_exception: unknown, context: CaptureContext): void {
  if (!dsn) {
    return;
  }

  Sentry.withScope((scope) => {
    if (context.tags) {
      scope.setTags(context.tags);
    }

    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      const { traceId, spanId } = activeSpan.spanContext();
      scope.setContext("opentelemetry", {
        trace_id: traceId,
        span_id: spanId,
      });
    }

    Sentry.captureException(new Error(context.message));
  });
}

export async function flushSentry(timeout = 2_000): Promise<boolean> {
  return dsn ? Sentry.flush(timeout) : true;
}
