import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { metrics, NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { parseOtlpHeaders, resolveOtlpHttpEndpoint, TRACE_LOG_KEYS } from "./config/tracing.config";

const otlpBaseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otlpTracesEndpoint = resolveOtlpHttpEndpoint(
  "traces",
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  otlpBaseEndpoint,
);
const otlpMetricsEndpoint = resolveOtlpHttpEndpoint(
  "metrics",
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  otlpBaseEndpoint,
);
const telemetryEnabled = Boolean(otlpTracesEndpoint || otlpMetricsEndpoint);

if (!telemetryEnabled) {
  console.warn("OpenTelemetry endpoint not set. Tracing and metrics disabled.");
}

const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "hyre-worker-nestjs",
    [ATTR_SERVICE_VERSION]: process.env.DEPLOYMENT_VERSION || "local",
    "deployment.environment.name": process.env.APP_ENV || process.env.NODE_ENV || "development",
    ...(process.env.FLY_MACHINE_ID && {
      [ATTR_SERVICE_INSTANCE_ID]: process.env.FLY_MACHINE_ID,
    }),
    ...(process.env.FLY_REGION && { "cloud.region": process.env.FLY_REGION }),
  }),
  spanProcessors: otlpTracesEndpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: otlpTracesEndpoint,
            headers: otlpHeaders,
          }),
        ),
      ]
    : [],
  metricReaders: otlpMetricsEndpoint
    ? [
        new metrics.PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: otlpMetricsEndpoint,
            headers: otlpHeaders,
          }),
        }),
      ]
    : [],
  // Pino logs use the dedicated transport configured by ObservabilityModule.
  logRecordProcessors: [],
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": {
        enabled: false,
      },
      "@opentelemetry/instrumentation-openai": {
        enabled: false,
      },
      "@opentelemetry/instrumentation-ioredis": {
        dbStatementSerializer: (commandName) => commandName,
      },
      "@opentelemetry/instrumentation-pino": {
        disableLogSending: true,
        logKeys: TRACE_LOG_KEYS,
      },
    }),
  ],
});

if (telemetryEnabled) {
  sdk.start();
}

let shutdownPromise: Promise<void> | undefined;

export function shutdownOpenTelemetry(): Promise<void> {
  if (!telemetryEnabled) {
    return Promise.resolve();
  }

  shutdownPromise ??= sdk.shutdown();
  return shutdownPromise;
}

export default sdk;
