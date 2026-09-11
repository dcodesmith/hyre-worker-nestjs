import { type Context, context as otelContext, propagation, trace } from "@opentelemetry/api";
import {
  type Attributes,
  type AttributeValue,
  type Exception,
  type Job,
  type Span,
  type SpanOptions,
  type Telemetry,
  type Time,
  type Tracer,
  UnrecoverableError,
} from "bullmq";
import { BullMQOtel } from "bullmq-otel";
import { captureException } from "../../../sentry";

// Processor results and errors can include recipient addresses, tokens, or provider responses.
const SENSITIVE_ATTRIBUTES = new Set([
  "bullmq.job.failed.reason",
  "bullmq.job.progress",
  "bullmq.job.result",
]);

function omitSensitiveAttributes(attributes?: Attributes): Attributes | undefined {
  return attributes
    ? Object.fromEntries(
        Object.entries(attributes).filter(([key]) => !SENSITIVE_ATTRIBUTES.has(key)),
      )
    : undefined;
}

class SafeBullMqSpan implements Span<Context> {
  constructor(private readonly span: Span<Context>) {}

  setSpanOnContext(context: Context): Context {
    return this.span.setSpanOnContext(context);
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (!SENSITIVE_ATTRIBUTES.has(key)) {
      this.span.setAttribute(key, value);
    }
  }

  setAttributes(attributes: Attributes): void {
    this.span.setAttributes(omitSensitiveAttributes(attributes) ?? {});
  }

  addEvent(name: string, attributes?: Attributes): void {
    this.span.addEvent(name, omitSensitiveAttributes(attributes));
  }

  recordException(_exception: Exception, time?: Time): void {
    this.span.recordException({ name: "Error", message: "BullMQ job failed" }, time);
  }

  end(): void {
    this.span.end();
  }
}

class SafeBullMqTracer implements Tracer<Context> {
  constructor(private readonly tracer: Tracer<Context>) {}

  startSpan(name: string, options?: SpanOptions, context?: Context): Span<Context> {
    return new SafeBullMqSpan(this.tracer.startSpan(name, options, context));
  }
}

export function createBullMqTelemetry(name: string, version: string): Telemetry<Context> {
  const telemetry = new BullMQOtel({
    tracerName: name,
    meterName: name,
    version,
    enableMetrics: true,
  });

  return {
    contextManager: telemetry.contextManager,
    meter: telemetry.meter,
    tracer: new SafeBullMqTracer(telemetry.tracer),
  };
}

function getProducerTraceContext(job: Job): CaptureContext["traceContext"] {
  const metadata = job.opts.telemetry?.metadata;
  if (!metadata) {
    return undefined;
  }

  try {
    const carrier = JSON.parse(metadata) as unknown;
    if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) {
      return undefined;
    }
    const extractedContext = propagation.extract(otelContext.active(), carrier);
    return trace.getSpanContext(extractedContext);
  } catch {
    return undefined;
  }
}

type CaptureContext = Parameters<typeof captureException>[1];

export function captureTerminalJobFailure(
  job: Job | undefined,
  error: unknown,
  queueName: string,
): void {
  if (!job) {
    captureException(error, {
      message: "BullMQ job failed without context",
      tags: { "error.source": "bullmq", "queue.name": queueName },
    });
    return;
  }

  const maxAttempts = job.opts.attempts ?? 1;
  const isUnrecoverable = error instanceof UnrecoverableError;
  if (!job.finishedOn && !isUnrecoverable && job.attemptsMade < maxAttempts) {
    return;
  }

  captureException(error, {
    message: "BullMQ job failed terminally",
    tags: {
      "error.source": "bullmq",
      "job.name": job.name,
      "queue.name": queueName,
    },
    traceContext: getProducerTraceContext(job),
  });
}
