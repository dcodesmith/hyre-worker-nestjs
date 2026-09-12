import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Rates E2E Tests", () => {
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
    it("should return only user-facing rates for unauthenticated requests", async () => {
      const response = await request(app.getHttpServer()).get("/api/rates");
      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({
        platformCustomerServiceFeeRatePercent: 10,
        vatRatePercent: 7.5,
      });
      expect(response.body).not.toHaveProperty("securityDetailRate");
      expect(response.body).not.toHaveProperty("platformFleetOwnerCommissionRatePercent");
      expect(response.body).not.toHaveProperty("platformFeeRates");
      expect(response.body).not.toHaveProperty("taxRates");
      expect(response.body).not.toHaveProperty("addonRates");
    });

    it("should return only user-facing rates for authenticated non-admin users", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/rates")
        .set("Cookie", nonAdminCookie);
      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({
        platformCustomerServiceFeeRatePercent: 10,
        vatRatePercent: 7.5,
      });
    });
  });

  describe("GET /api/rates/admin", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await request(app.getHttpServer()).get("/api/rates/admin");
      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should reject non-admin users", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/rates/admin")
        .set("Cookie", nonAdminCookie);
      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should return all rates for admin", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/rates/admin")
        .set("Cookie", adminCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toHaveProperty("platformFeeRates");
      expect(response.body).toHaveProperty("taxRates");
      expect(response.body).not.toHaveProperty("addonRates");
      expect(response.body.platformFeeRates.length).toBeGreaterThanOrEqual(2);
      expect(response.body.taxRates.length).toBeGreaterThanOrEqual(1);

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
});
