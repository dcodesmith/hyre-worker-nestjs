import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";

describe("OpenTelemetry boot (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20dGVzdA==");
    vi.stubEnv("OTEL_SERVICE_NAME", "hyre-worker-e2e");

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({
      logger: false,
    });

    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("boots with OTLP env set and serves status without Grafana exporters", () => {
    return request(app.getHttpServer())
      .get("/")
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          service: "hyre-worker-nestjs",
          status: "ok",
        });
      });
  });
});
