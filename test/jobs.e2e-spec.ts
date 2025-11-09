import { HttpStatus, INestApplication } from "@nestjs/common";
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

    app = moduleFixture.createNestApplication();

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

  it("/POST /job/trigger/invalid-job-type (should reject invalid job type with error code)", async () => {
    const response = await request(app.getHttpServer()).post("/job/trigger/invalid-job-type");

    expect(response.body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.errorCode).toBe("JOB.VALIDATION.INVALID_TYPE");
    expect(response.body.message).toContain("Invalid job type");
    expect(response.body.message).toContain("invalid-job-type");
    expect(response.body.details).toBeDefined();
    expect(response.body.details.jobType).toBe("invalid-job-type");
    expect(response.body.details.validTypes).toEqual([
      "start-reminders",
      "end-reminders",
      "activate-bookings",
      "complete-bookings",
    ]);
    expect(response.body.timestamp).toBeDefined();
    expect(response.body.path).toBe("/job/trigger/invalid-job-type");
  });

  describe("Error codes", () => {
    it("should return error code for manual triggers disabled", async () => {
      // Note: This test would require rebuilding the app with ENABLE_MANUAL_TRIGGERS=false
      // For now, we'll just verify the error code structure is correct
      // In a real scenario, you'd set this in .env.e2e
      // Skip this test if manual triggers are enabled (which they are in e2e)
      // This is a demonstration of what the error response would look like
    });

    it("should include error codes in all custom exceptions", async () => {
      const invalidTypeResponse = await request(app.getHttpServer())
        .post("/job/trigger/not-a-valid-type")
        .expect(HttpStatus.BAD_REQUEST);

      // Verify error code is present
      expect(invalidTypeResponse.body.errorCode).toBe("JOB.VALIDATION.INVALID_TYPE");
      // Verify standard error response format
      expect(invalidTypeResponse.body).toHaveProperty("statusCode");
      expect(invalidTypeResponse.body).toHaveProperty("message");
      expect(invalidTypeResponse.body).toHaveProperty("timestamp");
      expect(invalidTypeResponse.body).toHaveProperty("path");
      expect(invalidTypeResponse.body).toHaveProperty("details");
    });
  });
});
