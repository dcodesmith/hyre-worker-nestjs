import { describe, expect, it } from "vitest";
import { resolveOtlpHttpEndpoint } from "./tracing.config";

describe("resolveOtlpHttpEndpoint", () => {
  it("expands the base endpoint for logs, metrics, and traces", () => {
    const base = "https://otlp.example.com/otlp";

    expect(resolveOtlpHttpEndpoint("logs", undefined, base)).toBe(
      "https://otlp.example.com/otlp/v1/logs",
    );
    expect(resolveOtlpHttpEndpoint("metrics", undefined, base)).toBe(
      "https://otlp.example.com/otlp/v1/metrics",
    );
    expect(resolveOtlpHttpEndpoint("traces", undefined, base)).toBe(
      "https://otlp.example.com/otlp/v1/traces",
    );
  });

  it("strips trailing slashes from the base endpoint before expanding", () => {
    expect(resolveOtlpHttpEndpoint("traces", undefined, "https://otlp.example.com/otlp/")).toBe(
      "https://otlp.example.com/otlp/v1/traces",
    );
    expect(resolveOtlpHttpEndpoint("logs", undefined, "https://otlp.example.com/otlp///")).toBe(
      "https://otlp.example.com/otlp/v1/logs",
    );
  });

  it("prefers a signal-specific endpoint over the base endpoint", () => {
    expect(
      resolveOtlpHttpEndpoint(
        "traces",
        "https://tempo.example.com/v1/traces",
        "https://otlp.example.com/otlp",
      ),
    ).toBe("https://tempo.example.com/v1/traces");
    expect(
      resolveOtlpHttpEndpoint(
        "metrics",
        "https://mimir.example.com/v1/metrics",
        "https://otlp.example.com/otlp/",
      ),
    ).toBe("https://mimir.example.com/v1/metrics");
    expect(
      resolveOtlpHttpEndpoint(
        "logs",
        "https://loki.example.com/v1/logs",
        "https://otlp.example.com/otlp",
      ),
    ).toBe("https://loki.example.com/v1/logs");
  });

  it("returns undefined when endpoints are missing or blank", () => {
    expect(resolveOtlpHttpEndpoint("traces", undefined, undefined)).toBeUndefined();
    expect(resolveOtlpHttpEndpoint("metrics", "", "")).toBeUndefined();
    expect(resolveOtlpHttpEndpoint("logs", undefined, "")).toBeUndefined();
  });

  it("falls back to the base endpoint when the signal-specific value is blank", () => {
    expect(resolveOtlpHttpEndpoint("traces", "", "https://otlp.example.com/otlp")).toBe(
      "https://otlp.example.com/otlp/v1/traces",
    );
  });
});
