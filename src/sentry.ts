import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSpanContextValid,
  isValidSpanId,
  isValidTraceId,
  type SpanContext,
  trace,
} from "@opentelemetry/api";
import * as Sentry from "@sentry/nestjs";
import { shutdownOpenTelemetry } from "./tracing";

const dsn = process.env.SENTRY_DSN;
const ERROR_SUMMARIES = [
  "Application bootstrap failed",
  "BullMQ job exhausted retries",
  "BullMQ job failed without context",
  "Domain outbox event failed permanently",
  "Event handler failed",
  "Failed to dispatch domain outbox event",
  "Failed to dispatch notification outbox event",
  "Failed to load payments for reconciliation",
  "Failed to process domain outbox events",
  "Failed to process notification outbox events",
  "Failed to reconcile missing FlightAware alerts",
  "Failed to reconcile one or more successful payments",
  "Failed to reconcile processing payouts",
  "Failed to reconcile processing refunds",
  "Failed to requeue one or more FlightAware alerts",
  "Failed to schedule booking reminders",
  "Failed to schedule status updates",
  "HTTP request failed",
  "Scheduled task failed",
  "Uncaught exception",
  "Unhandled promise rejection",
  "WhatsApp outbox message failed permanently",
] as const;
type ErrorSummary = (typeof ERROR_SUMMARIES)[number];
const SAFE_SUMMARIES = new Set<string>(ERROR_SUMMARIES);
const SAFE_MECHANISMS = new Set([
  "auto.node.onuncaughtexception",
  "auto.node.onunhandledrejection",
  "generic",
]);
const SAFE_NAME = /^[A-Za-z0-9:_-]{1,100}$/;
const SAFE_OPERATION = /^[A-Za-z][A-Za-z0-9.]{1,127}$/;

function validTraceIds(
  traceId: unknown,
  spanId: unknown,
): { traceId: string; spanId: string } | undefined {
  return typeof traceId === "string" &&
    typeof spanId === "string" &&
    isValidTraceId(traceId) &&
    isValidSpanId(spanId)
    ? { traceId, spanId }
    : undefined;
}

function inferSummary(event: Sentry.ErrorEvent): ErrorSummary {
  const configuredSummary = event.tags?.["error.summary"];
  if (typeof configuredSummary === "string" && SAFE_SUMMARIES.has(configuredSummary)) {
    return configuredSummary as ErrorSummary;
  }

  const mechanism = event.exception?.values?.at(-1)?.mechanism?.type;
  return mechanism === "auto.node.onunhandledrejection"
    ? "Unhandled promise rejection"
    : "Uncaught exception";
}

function isInjectedMessageFrame(frame: Sentry.StackFrame, originalException: unknown): boolean {
  if (!(originalException instanceof Error) || !frame.filename || !frame.lineno) {
    return false;
  }

  return originalException.message
    .split(/\r?\n/)
    .slice(1)
    .some((line) => line.includes(frame.filename as string) && line.includes(`:${frame.lineno}`));
}

function sanitizeFrame(
  frame: Sentry.StackFrame,
  originalException: unknown,
): Sentry.StackFrame | undefined {
  if (
    !frame.filename ||
    !Number.isSafeInteger(frame.lineno) ||
    (frame.lineno as number) <= 0 ||
    isInjectedMessageFrame(frame, originalException)
  ) {
    return undefined;
  }

  let filename = frame.filename.replaceAll("\\", "/");
  if (hasUnsafePathCharacters(filename)) {
    return undefined;
  }
  if (/^node:[a-z0-9_./-]+$/i.test(filename)) {
    return {
      filename,
      lineno: frame.lineno,
      ...(Number.isSafeInteger(frame.colno) &&
        (frame.colno as number) > 0 && { colno: frame.colno }),
      in_app: false,
    };
  }

  if (filename.startsWith("file://")) {
    try {
      filename = fileURLToPath(filename);
    } catch {
      return undefined;
    }
  }

  if (hasUnsafePathCharacters(filename)) {
    return undefined;
  }

  if (!isAbsolute(filename)) {
    return undefined;
  }
  const relativeFilename = relative(process.cwd(), filename).replaceAll("\\", "/");
  if (
    !relativeFilename ||
    relativeFilename === ".." ||
    relativeFilename.startsWith("../") ||
    relativeFilename.startsWith("/")
  ) {
    return undefined;
  }

  return {
    filename: `app:///${relativeFilename}`,
    lineno: frame.lineno,
    ...(Number.isSafeInteger(frame.colno) && (frame.colno as number) > 0 && { colno: frame.colno }),
    in_app: !relativeFilename.includes("/node_modules/"),
  };
}

function hasUnsafePathCharacters(value: string): boolean {
  return [...value].some(
    (character) => (character.codePointAt(0) ?? 0) < 32 || "=?#".includes(character),
  );
}

function grafanaTraceUrl(traceId: string, timestamp: unknown): string | undefined {
  const configured = process.env.GRAFANA_TRACES_BASE_URL;
  if (!configured) {
    return undefined;
  }

  try {
    const origin = new URL(configured);
    if (origin.protocol !== "https:") {
      return undefined;
    }
    const occurredAtMs =
      typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp * 1000 : Date.now();
    const left = JSON.stringify({
      datasource: "grafanacloud-traces",
      queries: [{ query: traceId, queryType: "traceql", refId: "A" }],
      range: {
        from: new Date(occurredAtMs - 60 * 60 * 1000).toISOString(),
        to: new Date(occurredAtMs + 15 * 60 * 1000).toISOString(),
      },
    });
    return `${origin.origin}/explore?left=${encodeURIComponent(left)}`;
  } catch {
    return undefined;
  }
}

function sanitizeTags(tags: Sentry.ErrorEvent["tags"]): Sentry.ErrorEvent["tags"] {
  const safeTags: NonNullable<Sentry.ErrorEvent["tags"]> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (
      (key === "error.source" &&
        ["bootstrap", "bullmq", "event", "http", "scheduler"].includes(String(value))) ||
      (key === "error.summary" && SAFE_SUMMARIES.has(value as ErrorSummary)) ||
      (key === "http.method" && /^[A-Z]{3,10}$/.test(String(value))) ||
      (key === "http.status_code" &&
        Number.isInteger(value) &&
        Number(value) >= 500 &&
        Number(value) < 600) ||
      (key === "background.operation" && SAFE_OPERATION.test(String(value))) ||
      ((key === "job.name" || key === "queue.name") && SAFE_NAME.test(String(value)))
    ) {
      safeTags[key] = value;
    }
  }
  return safeTags;
}

function sanitizeEvent(event: Sentry.ErrorEvent, hint: Sentry.EventHint): Sentry.ErrorEvent | null {
  try {
    const summary = inferSummary(event);
    const originalException = hint.originalException;
    const sourceException = event.exception?.values?.at(-1);
    const frames = sourceException?.stacktrace?.frames
      ?.map((frame) => sanitizeFrame(frame, originalException))
      .filter((frame): frame is Sentry.StackFrame => Boolean(frame));
    const mechanism = sourceException?.mechanism;
    const otelContext = event.contexts?.opentelemetry;
    const activeSpanContext = trace.getActiveSpan()?.spanContext();
    const traceContext =
      validTraceIds(otelContext?.trace_id, otelContext?.span_id) ??
      validTraceIds(activeSpanContext?.traceId, activeSpanContext?.spanId);
    const tags = sanitizeTags(event.tags);
    const grafanaUrl = traceContext
      ? grafanaTraceUrl(traceContext.traceId, event.timestamp)
      : undefined;
    if (traceContext) {
      tags["otel.trace_id"] = traceContext.traceId;
      tags["otel.span_id"] = traceContext.spanId;
    }

    return {
      type: undefined,
      event_id: event.event_id,
      timestamp: event.timestamp,
      level: event.level,
      platform: "node",
      release: event.release,
      dist: event.dist,
      environment: event.environment,
      tags,
      ...(traceContext && {
        contexts: {
          opentelemetry: {
            trace_id: traceContext.traceId,
            span_id: traceContext.spanId,
          },
          ...(grafanaUrl && { grafana: { "View trace": grafanaUrl } }),
        },
      }),
      ...(sourceException && {
        exception: {
          values: [
            {
              type:
                sourceException.type &&
                /^[A-Za-z][A-Za-z0-9_.]{0,90}(?:Error|Exception)$/.test(sourceException.type)
                  ? sourceException.type
                  : "Error",
              value: summary,
              ...(mechanism &&
                SAFE_MECHANISMS.has(mechanism.type) && {
                  mechanism: { type: mechanism.type, handled: mechanism.handled },
                }),
              ...(frames?.length && { stacktrace: { frames } }),
            },
          ],
        },
      }),
    };
  } catch {
    return null;
  }
}

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
  release: process.env.DEPLOYMENT_VERSION || "local",
  defaultIntegrations: false,
  integrations: dsn
    ? [
        Sentry.onUncaughtExceptionIntegration({
          exitEvenIfOtherHandlersAreRegistered: true,
          onFatalError: terminateAfterFatalError,
        }),
        Sentry.onUnhandledRejectionIntegration({ mode: "none" }),
      ]
    : [],
  skipOpenTelemetrySetup: true,
  tracesSampleRate: 0,
  profileSessionSampleRate: 0,
  registerEsmLoaderHooks: false,
  includeServerName: false,
  includeLocalVariables: false,
  maxBreadcrumbs: 0,
  enableLogs: false,
  enableMetrics: false,
  sendDefaultPii: false,
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
  beforeSend: sanitizeEvent,
});

type CaptureContext = {
  message: ErrorSummary;
  tags?: Record<string, string | number | boolean>;
  traceContext?: Pick<SpanContext, "traceId" | "spanId" | "traceFlags">;
};

export function captureException(exception: unknown, context: CaptureContext): void {
  if (!dsn) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTags({
      ...context.tags,
      "error.summary": context.message,
    });
    const explicitTraceContext = context.traceContext;
    const spanContext =
      explicitTraceContext && isSpanContextValid(explicitTraceContext)
        ? explicitTraceContext
        : trace.getActiveSpan()?.spanContext();
    if (spanContext && isSpanContextValid(spanContext)) {
      scope.setTags({
        "otel.trace_id": spanContext.traceId,
        "otel.span_id": spanContext.spanId,
      });
      scope.setContext("opentelemetry", {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
      });
    }
    Sentry.captureException(
      exception instanceof Error ? exception : new Error("Non-Error exception"),
    );
  });
}

export async function flushSentry(timeout = 2_000): Promise<boolean> {
  return dsn ? Sentry.flush(timeout) : true;
}

let fatalShutdownStarted = false;

export function terminateAfterFatalError(): void {
  if (fatalShutdownStarted) {
    return;
  }
  fatalShutdownStarted = true;

  const forceExit = setTimeout(() => process.exit(1), 2_500);
  void Promise.allSettled([flushSentry(), shutdownOpenTelemetry()]).finally(() => {
    clearTimeout(forceExit);
    process.exit(1);
  });
}

let rejectionHandlerRegistered = false;

export function registerUnhandledRejectionHandler(): void {
  if (rejectionHandlerRegistered) {
    return;
  }
  rejectionHandlerRegistered = true;
  process.on("unhandledRejection", terminateAfterFatalError);
  if (!dsn) {
    process.on("uncaughtException", terminateAfterFatalError);
  }
}
