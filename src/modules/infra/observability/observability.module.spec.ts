import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { PARAMS_PROVIDER_TOKEN } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservabilityModule } from "./observability.module";

type PinoHttpParams = {
  pinoHttp: {
    level?: string;
    transport?: {
      targets?: Array<{
        target: string;
        options?: { url?: string; headers?: Record<string, string> };
      }>;
    };
  };
};

async function loadPinoParams(): Promise<PinoHttpParams> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
      }),
      ObservabilityModule,
    ],
  }).compile();

  try {
    return module.get<PinoHttpParams>(PARAMS_PROVIDER_TOKEN);
  } finally {
    await module.close();
  }
}

function otlpLogTarget(params: PinoHttpParams) {
  return params.pinoHttp.transport?.targets?.find(
    (target) => target.target === "pino-opentelemetry-transport",
  );
}

describe("ObservabilityModule OTLP logs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the test logger silent even when an OTLP logs endpoint is set", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otlp.example.com/otlp");
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://loki.example.com/v1/logs");

    const params = await loadPinoParams();

    expect(params.pinoHttp.level).toBe("silent");
    expect(params.pinoHttp.transport).toBeUndefined();
  });

  it("does not add the OTLP log transport from the base endpoint alone", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otlp.example.com/otlp/");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20dGVzdA==");

    const params = await loadPinoParams();

    expect(otlpLogTarget(params)).toBeUndefined();
    expect(params.pinoHttp.transport?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "pino/file",
        }),
      ]),
    );
  });

  it("adds the OTLP log transport only when a logs endpoint is explicit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otlp.example.com/otlp");
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://loki.example.com/v1/logs");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20dGVzdA==");
    vi.stubEnv("OTEL_SERVICE_NAME", "hyre-worker-nestjs");

    const params = await loadPinoParams();

    expect(otlpLogTarget(params)).toMatchObject({
      target: "pino-opentelemetry-transport",
      options: {
        url: "https://loki.example.com/v1/logs",
        headers: { Authorization: "Basic dGVzdA==" },
      },
    });
  });

  it("omits the OTLP log transport when no logs endpoint is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const params = await loadPinoParams();

    expect(otlpLogTarget(params)).toBeUndefined();
    expect(params.pinoHttp.transport?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "pino/file",
        }),
      ]),
    );
  });
});
