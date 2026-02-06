import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { parseOtlpHeaders, TRACE_LOG_KEYS } from "./config/tracing.config";

const otlpTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

if (!otlpTracesEndpoint) {
  console.warn("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT not set. Tracing disabled.");
}

const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

// The SDK handles traces, metrics, and logs
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "hyre-worker-nestjs",
  }),
  traceExporter: otlpTracesEndpoint
    ? new OTLPTraceExporter({
        url: otlpTracesEndpoint,
        headers: otlpHeaders,
      })
    : undefined,
  // Auto-instruments HTTP, Express, NestJS core, Prisma, ioredis, axios
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs instrumentation (too noisy for most apps)
      "@opentelemetry/instrumentation-fs": {
        enabled: false,
      },
    }),
    new PinoInstrumentation({
      logKeys: TRACE_LOG_KEYS,
    }),
  ],
});

// Start the SDK only if tracing is configured
if (otlpTracesEndpoint) {
  sdk.start();
}

export default sdk;
