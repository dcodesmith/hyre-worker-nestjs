import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Payments E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let factory: TestDataFactory;

  // Test data
  let testUserId: string;
  let testUserCookie: string;
  let otherUserCookie: string;
  let testBookingId: string;

  beforeAll(async () => {
    const mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOTPEmail })
      .compile();

    app = moduleFixture.createNestApplication();

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    flutterwaveService = app.get(FlutterwaveService);
    factory = new TestDataFactory(databaseService, app);

    await app.init();

    // Create test user
    const testEmail = uniqueEmail("payment-test-user");
    const testResult = await factory.authenticateAndGetUser(testEmail, "user");
    testUserCookie = testResult.cookie;
    testUserId = testResult.user.id;

    // Create another user (for ownership tests)
    const otherEmail = uniqueEmail("payment-other-user");
    otherUserCookie = await factory.authenticateAndGetCookie(otherEmail, "user");

    // Create a booking with all dependencies (fleet owner, car)
    const booking = await factory.createBookingWithDependencies(testUserId);
    testBookingId = booking.id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/payments/initialize", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(app.getHttpServer()).post("/api/payments/initialize").send({
        type: "booking",
        entityId: testBookingId,
        amount: 50000,
        callbackUrl: "https://example.com/callback",
      });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should initialize payment for a booking", async () => {
      const mockPaymentIntent = {
        paymentIntentId: `booking_${testBookingId}`,
        checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
      };
      vi.spyOn(flutterwaveService, "createPaymentIntent").mockResolvedValueOnce(mockPaymentIntent);

      const response = await request(app.getHttpServer())
        .post("/api/payments/initialize")
        .set("Cookie", testUserCookie)
        .send({
          type: "booking",
          entityId: testBookingId,
          amount: 50000,
          callbackUrl: "https://example.com/callback",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.paymentIntentId).toBe(mockPaymentIntent.paymentIntentId);
      expect(response.body.checkoutUrl).toBe(mockPaymentIntent.checkoutUrl);
    });

    it("should reject payment for non-existent booking", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/payments/initialize")
        .set("Cookie", testUserCookie)
        .send({
          type: "booking",
          entityId: "non-existent-id",
          amount: 50000,
          callbackUrl: "https://example.com/callback",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should reject payment for booking owned by another user", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/payments/initialize")
        .set("Cookie", otherUserCookie)
        .send({
          type: "booking",
          entityId: testBookingId,
          amount: 50000,
          callbackUrl: "https://example.com/callback",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toContain("permission");
    });

    it("should validate request body with Zod schema", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/payments/initialize")
        .set("Cookie", testUserCookie)
        .send({
          type: "invalid-type",
          entityId: "not-a-uuid",
          amount: 50, // Below minimum
          callbackUrl: "not-a-url",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toBe("Validation failed");
      expect(response.body.errors).toBeDefined();
      expect(Array.isArray(response.body.errors)).toBe(true);
    });
  });

  describe("GET /api/payments/status/:txRef", () => {
    let testPaymentTxRef: string;

    beforeAll(async () => {
      const payment = await factory.createPayment(testBookingId);
      testPaymentTxRef = payment.txRef;
    });

    it("should return 401 when not authenticated", async () => {
      const response = await request(app.getHttpServer()).get(
        `/api/payments/status/${testPaymentTxRef}`,
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should return payment status for authenticated user", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/payments/status/${testPaymentTxRef}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.txRef).toBe(testPaymentTxRef);
      expect(response.body.status).toBe("PENDING");
      expect(response.body.amountExpected).toBe(50000);
    });

    it("should return 404 for non-existent payment", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/payments/status/non-existent-txref")
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it("should reject access to payment owned by another user", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/payments/status/${testPaymentTxRef}`)
        .set("Cookie", otherUserCookie);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toContain("permission");
    });
  });

  describe("POST /api/payments/:txRef/refund", () => {
    let successfulPaymentTxRef: string;

    beforeAll(async () => {
      const payment = await factory.createPayment(testBookingId, {
        amountExpected: 50000,
        amountCharged: 50000,
        status: "SUCCESSFUL",
        flutterwaveTransactionId: "FLW-12345",
        confirmedAt: new Date(),
      });
      successfulPaymentTxRef = payment.txRef;
    });

    it("should return 401 when not authenticated", async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/payments/${successfulPaymentTxRef}/refund`)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should reject refund when user does not own the payment", async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/payments/${successfulPaymentTxRef}/refund`)
        .set("Cookie", otherUserCookie)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toContain("permission");
    });

    it("should initiate refund for booking owner", async () => {
      const mockRefundResult = {
        success: true,
        refundId: 12345,
        status: "pending",
      };
      vi.spyOn(flutterwaveService, "initiateRefund").mockResolvedValueOnce(mockRefundResult);

      const response = await request(app.getHttpServer())
        .post(`/api/payments/${successfulPaymentTxRef}/refund`)
        .set("Cookie", testUserCookie)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.success).toBe(true);
      expect(response.body.refundId).toBeDefined();
    });

    it("should return 404 for non-existent payment", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/payments/non-existent-txref/refund")
        .set("Cookie", testUserCookie)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it("should reject refund for non-successful payment", async () => {
      const pendingPayment = await factory.createPayment(testBookingId, {
        status: "PENDING",
      });

      const response = await request(app.getHttpServer())
        .post(`/api/payments/${pendingPayment.txRef}/refund`)
        .set("Cookie", testUserCookie)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toContain("not successful");
    });

    it("should reject refund amount exceeding payment amount", async () => {
      const excessPayment = await factory.createPayment(testBookingId, {
        status: "SUCCESSFUL",
        amountCharged: 50000,
        flutterwaveTransactionId: `FLW-EXCESS-${Date.now()}`,
      });

      const response = await request(app.getHttpServer())
        .post(`/api/payments/${excessPayment.txRef}/refund`)
        .set("Cookie", testUserCookie)
        .send({ amount: 100000, reason: "Too much refund" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toContain("exceed");
    });

    it("should validate refund request body with Zod schema", async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/payments/${successfulPaymentTxRef}/refund`)
        .set("Cookie", testUserCookie)
        .send({ amount: 50 }); // Below minimum of 100

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.message).toBe("Validation failed");
    });
  });
});
