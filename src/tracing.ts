import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

if (!otlpEndpoint) {
  console.warn("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT not set. Tracing disabled.");
}

const otlpHeadersRaw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
const otlpHeaders = otlpHeadersRaw
  ? Object.fromEntries(
      otlpHeadersRaw
        .split(",")
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const [key, ...rest] = pair.split("=");
          const rawKey = key.trim();
          const rawValue = rest.join("=").trim();
          try {
            return [decodeURIComponent(rawKey), decodeURIComponent(rawValue)];
          } catch {
            return [rawKey, rawValue];
          }
        })
        .filter(([key, value]) => key && value),
    )
  : undefined;

// The SDK handles traces, metrics, and logs
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "hyre-worker-nestjs",
  }),
  traceExporter: otlpEndpoint
    ? new OTLPTraceExporter({
        url: otlpEndpoint,
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
  ],
});

// Start the SDK only if tracing is configured
if (otlpEndpoint) {
  sdk.start();
}

export default sdk;
