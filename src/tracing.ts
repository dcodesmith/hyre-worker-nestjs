import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const otlpHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;

if (!otlpEndpoint) {
  console.warn("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT not set. Tracing disabled.");
}

// The SDK handles traces, metrics, and logs
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "hyre-worker-nestjs",
  }),
  traceExporter: otlpEndpoint
    ? new OTLPTraceExporter({
        url: otlpEndpoint,
        headers: otlpHeaders
          ? {
              Authorization: otlpHeaders,
            }
          : undefined,
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
  ],
});

// Start the SDK only if tracing is configured
if (otlpEndpoint) {
  sdk.start();
}

// Graceful shutdown
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log("OTel SDK shut down successfully"))
    .catch((err) => console.error("Error shutting down OTel SDK:", err))
    .finally(() => process.exit(0));
});

export default sdk;
