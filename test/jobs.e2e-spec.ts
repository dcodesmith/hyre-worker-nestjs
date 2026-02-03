import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";

describe("Jobs E2E Tests", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({
      logger: false,
    });

    // Register global exception filter (same as in main.ts)
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const jobTypes = [
    { type: "start-reminders", message: "Start reminder job triggered" },
    { type: "activate-bookings", message: "Activate bookings job triggered" },
    { type: "end-reminders", message: "End reminder job triggered" },
    { type: "complete-bookings", message: "Complete bookings job triggered" },
  ] as const;

  describe.each(jobTypes)("/POST /job/trigger/$type", ({ type, message }) => {
    it("should enforce rate limiting", async () => {
      const endpoint = `/job/trigger/${type}`;

      const firstResponse = await request(app.getHttpServer())
        .post(endpoint)
        .expect(HttpStatus.ACCEPTED);

      expect(firstResponse.body).toStrictEqual({
        success: true,
        message,
      });

      const secondResponse = await request(app.getHttpServer()).post(endpoint);

      expect(secondResponse.body).toStrictEqual({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        errorCode: "JOB.RATE_LIMIT.EXCEEDED",
        message: `Rate limit exceeded for job type: ${type}`,
        details: { jobType: type, retryAfter: expect.any(Number) },
        timestamp: expect.any(String),
        path: endpoint,
      });

      // Verify retryAfter is approximately 1 hour from now (3600 seconds)
      const now = Math.ceil(Date.now() / 1000);

      // Allow for reasonable clock skew and processing delays (±5 minutes)
      expect(secondResponse.body.details.retryAfter).toBeGreaterThanOrEqual(now + 3300);
      expect(secondResponse.body.details.retryAfter).toBeLessThanOrEqual(now + 3900);
    });
  });
});
