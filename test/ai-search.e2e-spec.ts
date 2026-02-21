import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AiSearchTimeoutException } from "../src/modules/ai-search/ai-search.error";
import { OpenAiAiSearchExtractorService } from "../src/modules/ai-search/openai-ai-search-extractor.service";

describe("AI Search E2E Tests", () => {
  let app: INestApplication;
  let extractorService: { extract: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    extractorService = {
      extract: vi.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OpenAiAiSearchExtractorService)
      .useValue(extractorService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("POST /api/ai-search returns structured response", async () => {
    extractorService.extract.mockResolvedValue({
      make: "Toyota",
      model: "Camry",
      vehicleType: "SEDAN",
      from: "2026-03-01",
      to: "2026-03-02",
      bookingType: "DAY",
    });

    const response = await request(app.getHttpServer())
      .post("/api/ai-search")
      .send({ query: "Need a toyota camry sedan for two days" });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body.params.make).toBe("Toyota");
    expect(response.body.raw.vehicleType).toBe("SEDAN");
    expect(response.body.interpretation).toContain("Looking for:");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("POST /api/ai-search returns 400 for invalid payload", async () => {
    const response = await request(app.getHttpServer()).post("/api/ai-search").send({ query: "" });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("POST /api/ai-search returns timeout error when provider times out", async () => {
    extractorService.extract.mockRejectedValue(new AiSearchTimeoutException());

    const response = await request(app.getHttpServer())
      .post("/api/ai-search")
      .send({ query: "Need a car" });

    expect(response.status).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(response.body.detail).toBe("AI search request timed out. Please try again.");
  });
});
