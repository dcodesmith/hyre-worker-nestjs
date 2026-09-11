import type { Context } from "@opentelemetry/api";
import type {
  Attributes,
  AttributeValue,
  Exception,
  Span,
  SpanOptions,
  Telemetry,
  Time,
  Tracer,
} from "bullmq";
import { BullMQOtel } from "bullmq-otel";

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
