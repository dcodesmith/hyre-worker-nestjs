/**
 * OpenTelemetry trace field mappings for Pino logs.
 * These field names are used by both:
 * - @opentelemetry/instrumentation-pino (injects trace context into logs)
 * - nestjs-pino LoggerModule (configures log output format)
 */
export const TRACE_LOG_KEYS = {
  traceId: "trace_id",
  spanId: "span_id",
  traceFlags: "trace_flags",
} as const;

/**
 * Parses OTEL_EXPORTER_OTLP_HEADERS environment variable.
 * Format: "key1=value1,key2=value2"
 * Values are percent-decoded per OTLP specification.
 *
 * @param otlpHeadersRaw - Raw header string from environment variable
 * @returns Parsed headers object or undefined if empty
 *
 * @example
 * parseOtlpHeaders("Authorization=Bearer%20token,X-Custom=value")
 * // Returns: { "Authorization": "Bearer token", "X-Custom": "value" }
 */
export function parseOtlpHeaders(
  otlpHeadersRaw: string | undefined,
): Record<string, string> | undefined {
  if (!otlpHeadersRaw) {
    return undefined;
  }

  return Object.fromEntries(
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
  );
}
