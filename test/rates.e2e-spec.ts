import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Rates Admin E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: async () => undefined })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
    await app.init();

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("rates-admin"));
    adminCookie = adminAuth.cookie;

    const nonAdminAuth = await factory.authenticateAndGetUser(
      uniqueEmail("rates-nonadmin"),
      "user",
    );
    nonAdminCookie = nonAdminAuth.cookie;

    await factory.createPlatformRates();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe("GET /api/rates", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await request(app.getHttpServer()).get("/api/rates");
      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should reject non-admin users", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/rates")
        .set("Cookie", nonAdminCookie);
      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should return all rates for admin", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/rates")
        .set("Cookie", adminCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toHaveProperty("platformFeeRates");
      expect(response.body).toHaveProperty("taxRates");
      expect(response.body).toHaveProperty("addonRates");
      expect(response.body.platformFeeRates.length).toBeGreaterThanOrEqual(2);
      expect(response.body.taxRates.length).toBeGreaterThanOrEqual(1);
      expect(response.body.addonRates.length).toBeGreaterThanOrEqual(1);

      const activeServiceFee = response.body.platformFeeRates.find(
        (r: { feeType: string; active: boolean }) =>
          r.feeType === "PLATFORM_SERVICE_FEE" && r.active,
      );
      expect(activeServiceFee).toBeDefined();
      expect(activeServiceFee.ratePercent).toBe(10);
    });
  });

  describe("POST /api/rates/platform-fee", () => {
    it("should reject non-admin users", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/rates/platform-fee")
        .set("Cookie", nonAdminCookie)
        .send({
          feeType: "PLATFORM_SERVICE_FEE",
          ratePercent: 12,
          effectiveSince: "2030-01-01",
        });
      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should reject invalid date ranges", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/rates/platform-fee")
        .set("Cookie", adminCookie)
        .send({
          feeType: "PLATFORM_SERVICE_FEE",
          ratePercent: 12,
          effectiveSince: "2030-06-01",
          effectiveUntil: "2030-01-01",
        });
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should reject overlapping platform fee rates", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/rates/platform-fee")
        .set("Cookie", adminCookie)
        .send({
          feeType: "PLATFORM_SERVICE_FEE",
          ratePercent: 12,
          effectiveSince: "2021-01-01",
        });
      expect(response.status).toBe(HttpStatus.CONFLICT);
    });

    it("should create a new platform fee rate for a future window", async () => {
      await databaseService.platformFeeRate.updateMany({
        where: { feeType: "PLATFORM_SERVICE_FEE", effectiveUntil: null },
        data: { effectiveUntil: new Date("2039-12-31") },
      });

      const response = await request(app.getHttpServer())
        .post("/api/rates/platform-fee")
        .set("Cookie", adminCookie)
        .send({
          feeType: "PLATFORM_SERVICE_FEE",
          ratePercent: 12,
          effectiveSince: "2040-01-01",
          effectiveUntil: "2040-06-01",
          description: "Temporary fee increase",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.feeType).toBe("PLATFORM_SERVICE_FEE");
      expect(response.body.ratePercent).toBe(12);
      expect(response.body.description).toBe("Temporary fee increase");
    });
  });

  describe("POST /api/rates/vat", () => {
    it("should reject overlapping VAT rates", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/rates/vat")
        .set("Cookie", adminCookie)
        .send({
          ratePercent: 10,
          effectiveSince: "2021-01-01",
        });
      expect(response.status).toBe(HttpStatus.CONFLICT);
    });

    it("should create a new VAT rate for a future window", async () => {
      await databaseService.taxRate.updateMany({
        where: { effectiveUntil: null },
        data: { effectiveUntil: new Date("2040-12-31") },
      });

      const response = await request(app.getHttpServer())
        .post("/api/rates/vat")
        .set("Cookie", adminCookie)
        .send({
          ratePercent: 10,
          effectiveSince: "2041-01-01",
          effectiveUntil: "2041-12-31",
          description: "New VAT rate",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.ratePercent).toBe(10);
    });
  });

  describe("POST /api/rates/addon", () => {
    it("should reject overlapping addon rates", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/rates/addon")
        .set("Cookie", adminCookie)
        .send({
          addonType: "SECURITY_DETAIL",
          rateAmount: 20000,
          effectiveSince: "2021-01-01",
        });
      expect(response.status).toBe(HttpStatus.CONFLICT);
    });

    it("should create a new addon rate for a future window", async () => {
      await databaseService.addonRate.updateMany({
        where: { addonType: "SECURITY_DETAIL", effectiveUntil: null },
        data: { effectiveUntil: new Date("2041-12-31") },
      });

      const response = await request(app.getHttpServer())
        .post("/api/rates/addon")
        .set("Cookie", adminCookie)
        .send({
          addonType: "SECURITY_DETAIL",
          rateAmount: 20000,
          effectiveSince: "2042-01-01",
          effectiveUntil: "2042-12-31",
          description: "New security detail rate",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.rateAmount).toBe(20000);
      expect(response.body.addonType).toBe("SECURITY_DETAIL");
    });
  });

  describe("PATCH /api/rates/addon/:addonRateId/end", () => {
    it("should reject non-admin users", async () => {
      const response = await request(app.getHttpServer())
        .patch("/api/rates/addon/nonexistent/end")
        .set("Cookie", nonAdminCookie);
      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should return 404 for non-existent addon rate", async () => {
      const fakeId = "cm00000000000000000000000";
      const response = await request(app.getHttpServer())
        .patch(`/api/rates/addon/${fakeId}/end`)
        .set("Cookie", adminCookie);
      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it("should end an active addon rate", async () => {
      const addonRate = await databaseService.addonRate.create({
        data: {
          addonType: "SECURITY_DETAIL",
          rateAmount: 25000,
          effectiveSince: new Date("2043-01-01"),
          effectiveUntil: null,
        },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/rates/addon/${addonRate.id}/end`)
        .set("Cookie", adminCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.effectiveUntil).toBeDefined();
    });

    it("should reject ending an already-ended addon rate", async () => {
      const addonRate = await databaseService.addonRate.create({
        data: {
          addonType: "SECURITY_DETAIL",
          rateAmount: 30000,
          effectiveSince: new Date("2044-01-01"),
          effectiveUntil: new Date("2044-06-01"),
        },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/rates/addon/${addonRate.id}/end`)
        .set("Cookie", adminCookie);

      expect(response.status).toBe(HttpStatus.CONFLICT);
    });
  });
});
