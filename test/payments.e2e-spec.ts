import { randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { ExtensionReservationService } from "../src/modules/booking/extension-reservation.service";
import { DatabaseService } from "../src/modules/database/database.service";
import type { FlutterwaveFetchedRefundData } from "../src/modules/flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import type { FlutterwaveRefundWebhookData } from "../src/modules/flutterwave/flutterwave-webhook.schema";
import { RefundReconciliationService } from "../src/modules/payment/refund-reconciliation.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

function createRefundWebhookData(
  transactionId: number,
  overrides: Partial<FlutterwaveRefundWebhookData> = {},
): FlutterwaveRefundWebhookData {
  const now = new Date().toISOString();
  return {
    id: transactionId + 1,
    AmountRefunded: 50000,
    status: "completed",
    FlwRef: `FLW-REF-${transactionId}`,
    TransactionId: transactionId,
    destination: "card",
    comments: "Customer requested refund",
    settlement_id: "settle-123",
    meta: "{}",
    createdAt: now,
    updatedAt: now,
    walletId: 789,
    AccountId: 123,
    ...overrides,
  };
}

function createFetchedRefund(
  transactionId: number,
  overrides: Partial<FlutterwaveFetchedRefundData> = {},
): FlutterwaveFetchedRefundData {
  return {
    id: transactionId + 1,
    amount_refunded: 50000,
    status: "completed",
    flw_ref: `FLW-REF-${transactionId}`,
    comment: null,
    settlement_id: "NEW",
    meta: {},
    created_at: new Date().toISOString(),
    account_id: 123,
    transaction_id: transactionId,
    ...overrides,
  };
}

describe("Payments E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let refundReconciliationService: RefundReconciliationService;
  let extensionReservationService: ExtensionReservationService;
  let factory: TestDataFactory;

  let testUserId: string;
  let testUserCookie: string;
  let otherUserCookie: string;
  let testBookingId: string;

  beforeAll(async () => {
    const mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);

    process.env.FLUTTERWAVE_WEBHOOK_SECRET = "test-webhook-secret";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOTPEmail })
      .compile();

    app = moduleFixture.createNestApplication({
      logger: false,
    });

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    flutterwaveService = app.get(FlutterwaveService);
    refundReconciliationService = app.get(RefundReconciliationService);
    extensionReservationService = app.get(ExtensionReservationService);
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

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body.errorCode).toBe("PAYMENT_ENTITY_ACCESS_FORBIDDEN");
      expect(response.body.detail).toContain("permission");
    });
  });

  describe("GET /api/payments/status/:txRef", () => {
    let testPaymentTxRef: string;

    beforeAll(async () => {
      const payment = await factory.createPayment(testBookingId, {
        amountExpected: 50000,
        status: PaymentAttemptStatus.PENDING,
      });
      testPaymentTxRef = payment.txRef;
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

    it("should reject access to payment owned by another user", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/payments/status/${testPaymentTxRef}`)
        .set("Cookie", otherUserCookie);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body.errorCode).toBe("PAYMENT_ACCESS_FORBIDDEN");
      expect(response.body.detail).toContain("permission");
    });
  });

  describe("extension payment callback", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function createPendingExtension() {
      const booking = await factory.createBookingWithDependencies(testUserId, {
        booking: { status: "CONFIRMED", paymentStatus: "PAID" },
      });
      const bookingWindow = await databaseService.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { startDate: true, endDate: true },
      });
      const leg = await factory.createBookingLeg(booking.id, {
        legDate: bookingWindow.startDate,
        legStartTime: bookingWindow.startDate,
        legEndTime: bookingWindow.endDate,
      });
      const txRef = `ext-${randomUUID()}`;
      const extension = await factory.createExtension(leg.id, {
        paymentIntent: txRef,
        totalAmount: 5000,
        extensionStartTime: bookingWindow.endDate,
        extensionEndTime: new Date(bookingWindow.endDate.getTime() + 60 * 60 * 1000),
      });
      return { bookingId: booking.id, extensionId: extension.id, txRef };
    }

    function mockSuccessfulExtensionPayment(txRef: string) {
      const transactionId = String(Date.now() + Math.floor(Math.random() * 1000));
      vi.spyOn(flutterwaveService, "verifyTransaction").mockResolvedValueOnce({
        status: "success",
        message: "ok",
        data: {
          id: Number(transactionId),
          tx_ref: txRef,
          flw_ref: `FLW-EXT-${transactionId}`,
          amount: 5000,
          charged_amount: 5000,
          currency: "NGN",
          status: "successful",
          payment_type: "card",
          created_at: new Date().toISOString(),
        },
      });
      return transactionId;
    }

    it("returns pending extension status before a webhook creates the payment row", async () => {
      const pending = await createPendingExtension();

      const response = await request(app.getHttpServer())
        .get(`/api/payments/status/${pending.txRef}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual(
        expect.objectContaining({
          txRef: pending.txRef,
          status: "PENDING",
          amountExpected: 5000,
          extension: { id: pending.extensionId, status: "PENDING" },
        }),
      );
    });

    it("verifies and activates an extension from the authenticated callback", async () => {
      const pending = await createPendingExtension();
      const transactionId = mockSuccessfulExtensionPayment(pending.txRef);

      const response = await request(app.getHttpServer())
        .post("/api/payments/extension-confirmation")
        .set("Cookie", testUserCookie)
        .send({
          extensionId: pending.extensionId,
          txRef: pending.txRef,
          transactionId,
        });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual(
        expect.objectContaining({
          txRef: pending.txRef,
          status: "SUCCESSFUL",
          extension: { id: pending.extensionId, status: "ACTIVE" },
        }),
      );
    });

    it("reactivates an expired extension when its late payment is verified and the window is free", async () => {
      const pending = await createPendingExtension();
      await databaseService.extension.update({
        where: { id: pending.extensionId },
        data: { paymentSessionExpiresAt: new Date(Date.now() - 1) },
      });
      await expect(
        extensionReservationService.cancelExpiredReservation(pending.extensionId),
      ).resolves.toBe(true);
      const transactionId = mockSuccessfulExtensionPayment(pending.txRef);

      const response = await request(app.getHttpServer())
        .post("/api/payments/extension-confirmation")
        .set("Cookie", testUserCookie)
        .send({
          extensionId: pending.extensionId,
          txRef: pending.txRef,
          transactionId,
        });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.extension).toEqual({
        id: pending.extensionId,
        status: "ACTIVE",
      });
      const [extension, booking] = await Promise.all([
        databaseService.extension.findUniqueOrThrow({
          where: { id: pending.extensionId },
          select: { extensionEndTime: true },
        }),
        databaseService.booking.findUniqueOrThrow({
          where: { id: pending.bookingId },
          select: { endDate: true },
        }),
      ]);
      expect(booking.endDate.getTime()).toBeGreaterThanOrEqual(
        extension.extensionEndTime.getTime(),
      );
    });
  });

  describe("POST /api/payments/:txRef/refund", () => {
    let successfulPaymentTxRef: string;

    beforeAll(async () => {
      await databaseService.booking.update({
        where: { id: testBookingId },
        data: { paymentStatus: "PAID" },
      });
      const payment = await factory.createPayment(testBookingId, {
        amountExpected: 50000,
        amountCharged: 50000,
        status: "SUCCESSFUL",
        flutterwaveTransactionId: "FLW-12345",
        confirmedAt: new Date(),
      });
      successfulPaymentTxRef = payment.txRef;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should reject refund when user does not own the payment", async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/payments/${successfulPaymentTxRef}/refund`)
        .set("Cookie", otherUserCookie)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body.errorCode).toBe("PAYMENT_ACCESS_FORBIDDEN");
      expect(response.body.detail).toContain("permission");
    });

    it("initiates a refund after cancellation marks the booking as refund processing", async () => {
      const futureStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const booking = await factory.createBookingWithDependencies(testUserId, {
        booking: {
          startDate: futureStart,
          endDate: new Date(futureStart.getTime() + 12 * 60 * 60 * 1000),
        },
      });
      await databaseService.booking.update({
        where: { id: booking.id },
        data: {
          status: "CONFIRMED",
          paymentStatus: "PAID",
        },
      });
      const payment = await factory.createPayment(booking.id, {
        amountExpected: 50000,
        amountCharged: 50000,
        status: "SUCCESSFUL",
        flutterwaveTransactionId: `FLW-CANCELLED-${Date.now()}`,
        confirmedAt: new Date(),
      });
      vi.spyOn(flutterwaveService, "initiateRefund").mockResolvedValueOnce({
        success: true,
        refundId: Date.now(),
        status: "completed",
      });

      const cancellationResponse = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}/cancel`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Customer cancellation" });
      expect(cancellationResponse.status).toBe(HttpStatus.OK);

      const refundResponse = await request(app.getHttpServer())
        .post(`/api/payments/${payment.txRef}/refund`)
        .set("Cookie", testUserCookie)
        .send({ amount: 50000, reason: "Customer cancellation" });

      expect(refundResponse.status).toBe(HttpStatus.CREATED);
      await expect(factory.getPaymentById(payment.id)).resolves.toMatchObject({
        status: "REFUND_PROCESSING",
      });
      await expect(
        databaseService.booking.findUnique({
          where: { id: booking.id },
          select: { status: true, paymentStatus: true },
        }),
      ).resolves.toMatchObject({
        status: "CANCELLED",
        paymentStatus: "REFUND_PROCESSING",
      });
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

    it("should atomically record an operations notification for an explicit provider rejection", async () => {
      await databaseService.booking.update({
        where: { id: testBookingId },
        data: { paymentStatus: "PAID" },
      });
      const payment = await factory.createPayment(testBookingId, {
        amountExpected: 50000,
        amountCharged: 50000,
        status: "SUCCESSFUL",
        flutterwaveTransactionId: `FLW-REJECTED-${Date.now()}`,
        confirmedAt: new Date(),
      });
      vi.spyOn(flutterwaveService, "initiateRefund").mockResolvedValueOnce({
        success: false,
        error: "Provider rejected refund",
      });

      const response = await request(app.getHttpServer())
        .post(`/api/payments/${payment.txRef}/refund`)
        .set("Cookie", testUserCookie)
        .send({ amount: 25000, reason: "Customer cancellation" });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body).toMatchObject({
        success: false,
        error: "Provider rejected refund",
      });

      const updatedPayment = await factory.getPaymentById(payment.id);
      expect(updatedPayment?.status).toBe("REFUND_FAILED");
      expect(updatedPayment?.refundIdempotencyKey).toBeTruthy();
      await expect(
        databaseService.booking.findUnique({
          where: { id: testBookingId },
          select: { paymentStatus: true },
        }),
      ).resolves.toMatchObject({ paymentStatus: "REFUND_FAILED" });

      const notificationEvent = await databaseService.notificationOutboxEvent.findUnique({
        where: {
          dedupeKey: `refund-status:idempotency:${updatedPayment?.refundIdempotencyKey}:REFUND_FAILED`,
        },
      });
      expect(notificationEvent?.payload).toMatchObject({
        subtype: "REFUND_REFUND_FAILED",
        notificationJobData: {
          audience: "operations",
          channels: ["email"],
        },
      });
    });
  });

  describe("POST /api/payments/webhook/flutterwave", () => {
    let webhookSecret: string;

    beforeAll(() => {
      const configService = app.get(ConfigService);
      webhookSecret = configService.get("FLUTTERWAVE_WEBHOOK_SECRET") ?? "test-webhook-secret";
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("Signature Verification", () => {
      it("should accept request with valid verif-hash header", async () => {
        const uniqueId = Date.now() + Math.floor(Math.random() * 100000);
        const webhookData = {
          id: uniqueId,
          tx_ref: `non-existent-tx-ref-${uniqueId}`,
          status: "successful",
          charged_amount: 50000,
          flw_ref: `FLW-TEST-REF-${uniqueId}`,
          device_fingerprint: "test-device",
          amount: 50000,
          currency: "NGN",
          app_fee: 700,
          merchant_fee: 0,
          processor_response: "Approved",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test",
          payment_type: "card",
          created_at: new Date().toISOString(),
          account_id: 123,
          customer: {
            id: 456,
            name: "Test User",
            phone_number: null,
            email: "test@example.com",
            created_at: new Date().toISOString(),
          },
        };

        // Mock must return verification data that matches webhook data
        vi.spyOn(flutterwaveService, "verifyTransaction").mockResolvedValue({
          status: "success",
          message: "Transaction verified",
          data: webhookData,
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "charge.completed",
            data: webhookData,
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.status).toBe("ok");
      });

      it("acknowledges a signed unsupported webhook event", async () => {
        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.pending",
            data: { id: 123 },
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.status).toBe("ok");
      });
    });

    describe("charge.completed", () => {
      it("should confirm booking when payment is successful", async () => {
        const txRef = `tx-confirm-${Date.now()}`;
        const uniqueId = Date.now() + Math.floor(Math.random() * 100000) + 1;

        // Create a new pending booking with paymentIntent
        const pendingBooking = await factory.createBookingWithDependencies(testUserId, {
          booking: {
            status: "PENDING",
            paymentStatus: "UNPAID",
            paymentIntent: txRef,
            totalAmount: 50000,
          },
        });

        const webhookData = {
          id: uniqueId,
          tx_ref: txRef,
          status: "successful",
          charged_amount: 50000,
          flw_ref: `FLW-CONFIRM-REF-${uniqueId}`,
          device_fingerprint: "device-confirm",
          amount: 50000,
          currency: "NGN",
          app_fee: 700,
          merchant_fee: 0,
          processor_response: "Approved",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test payment for booking confirmation",
          payment_type: "card",
          created_at: new Date().toISOString(),
          account_id: 123,
          customer: {
            id: 456,
            name: "Test User",
            phone_number: null,
            email: "test@example.com",
            created_at: new Date().toISOString(),
          },
        };

        vi.spyOn(flutterwaveService, "verifyTransaction").mockResolvedValueOnce({
          status: "success",
          message: "Transaction verified",
          data: webhookData,
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "charge.completed",
            data: webhookData,
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.status).toBe("ok");

        // Verify booking was confirmed
        const confirmedBooking = await factory.getBookingById(pendingBooking.id);
        expect(confirmedBooking?.status).toBe("CONFIRMED");
        expect(confirmedBooking?.paymentStatus).toBe("PAID");
      });

      it("should not confirm booking when payment fails", async () => {
        const txRef = `tx-failed-${Date.now()}`;
        const uniqueId = Date.now() + Math.floor(Math.random() * 100000) + 2;

        // Create a new pending booking with paymentIntent
        const pendingBooking = await factory.createBookingWithDependencies(testUserId, {
          booking: {
            status: "PENDING",
            paymentStatus: "UNPAID",
            paymentIntent: txRef,
            totalAmount: 50000,
          },
        });

        const webhookData = {
          id: uniqueId,
          tx_ref: txRef,
          status: "failed",
          charged_amount: 50000,
          flw_ref: `FLW-FAILED-REF-${uniqueId}`,
          device_fingerprint: "device-failed",
          amount: 50000,
          currency: "NGN",
          app_fee: 700,
          merchant_fee: 0,
          processor_response: "Declined",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test failed payment",
          payment_type: "card",
          created_at: new Date().toISOString(),
          account_id: 123,
          customer: {
            id: 456,
            name: "Test User",
            phone_number: null,
            email: "test@example.com",
            created_at: new Date().toISOString(),
          },
        };

        vi.spyOn(flutterwaveService, "verifyTransaction").mockResolvedValueOnce({
          status: "success",
          message: "Transaction verified",
          data: webhookData,
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "charge.completed",
            data: webhookData,
          });

        expect(response.status).toBe(HttpStatus.OK);

        // Verify booking was NOT confirmed (still PENDING)
        const unchangedBooking = await factory.getBookingById(pendingBooking.id);
        expect(unchangedBooking?.status).toBe("PENDING");
        expect(unchangedBooking?.paymentStatus).toBe("UNPAID");
      });

      it("should activate extension when extension payment is successful", async () => {
        const txRef = `tx-extension-${Date.now()}`;
        const uniqueId = Date.now() + Math.floor(Math.random() * 100000) + 3;
        const booking = await factory.createBookingWithDependencies(testUserId, {
          booking: {
            status: "ACTIVE",
            paymentStatus: "PAID",
          },
        });

        const legStartTime = new Date("2026-01-01T09:00:00.000Z");
        const legEndTime = new Date("2026-01-01T11:00:00.000Z");
        const extensionEndTime = new Date("2026-01-01T13:00:00.000Z");

        const bookingLeg = await databaseService.bookingLeg.create({
          data: {
            bookingId: booking.id,
            legDate: new Date("2026-01-01T00:00:00.000Z"),
            totalDailyPrice: 50000,
            legStartTime,
            legEndTime,
            fleetOwnerEarningForLeg: 40000,
            itemsNetValueForLeg: 50000,
          },
        });

        const extension = await databaseService.extension.create({
          data: {
            bookingLegId: bookingLeg.id,
            paymentIntent: txRef,
            totalAmount: 5000,
            status: "PENDING",
            paymentStatus: "UNPAID",
            eventType: "HOURLY_ADDITION",
            extendedDurationHours: 2,
            extensionStartTime: legEndTime,
            extensionEndTime,
          },
        });

        const webhookData = {
          id: uniqueId,
          tx_ref: txRef,
          status: "successful",
          charged_amount: 5000,
          flw_ref: `FLW-EXT-REF-${uniqueId}`,
          device_fingerprint: "device-extension",
          amount: 5000,
          currency: "NGN",
          app_fee: 70,
          merchant_fee: 0,
          processor_response: "Approved",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test payment for extension activation",
          payment_type: "card",
          created_at: new Date().toISOString(),
          account_id: 123,
          customer: {
            id: 456,
            name: "Test User",
            phone_number: null,
            email: "test@example.com",
            created_at: new Date().toISOString(),
          },
        };

        vi.spyOn(flutterwaveService, "verifyTransaction").mockResolvedValueOnce({
          status: "success",
          message: "Transaction verified",
          data: webhookData,
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "charge.completed",
            data: webhookData,
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.status).toBe("ok");

        const updatedExtension = await databaseService.extension.findUnique({
          where: { id: extension.id },
        });
        expect(updatedExtension?.status).toBe("ACTIVE");
        expect(updatedExtension?.paymentStatus).toBe("PAID");
        expect(updatedExtension?.paymentId).toBeTruthy();

        const updatedLeg = await databaseService.bookingLeg.findUnique({
          where: { id: bookingLeg.id },
        });
        expect(updatedLeg?.legEndTime.toISOString()).toBe(extensionEndTime.toISOString());
      });

      it("should process duplicate extension webhook idempotently", async () => {
        const txRef = `tx-extension-idempotent-${Date.now()}`;
        const uniqueId = Date.now() + Math.floor(Math.random() * 100000) + 4;
        const booking = await factory.createBookingWithDependencies(testUserId, {
          booking: {
            status: "ACTIVE",
            paymentStatus: "PAID",
          },
        });

        const legStartTime = new Date("2026-01-02T09:00:00.000Z");
        const legEndTime = new Date("2026-01-02T11:00:00.000Z");
        const extensionEndTime = new Date("2026-01-02T12:00:00.000Z");

        const bookingLeg = await databaseService.bookingLeg.create({
          data: {
            bookingId: booking.id,
            legDate: new Date("2026-01-02T00:00:00.000Z"),
            totalDailyPrice: 50000,
            legStartTime,
            legEndTime,
            fleetOwnerEarningForLeg: 40000,
            itemsNetValueForLeg: 50000,
          },
        });

        const extension = await databaseService.extension.create({
          data: {
            bookingLegId: bookingLeg.id,
            paymentIntent: txRef,
            totalAmount: 5000,
            status: "PENDING",
            paymentStatus: "UNPAID",
            eventType: "HOURLY_ADDITION",
            extendedDurationHours: 1,
            extensionStartTime: legEndTime,
            extensionEndTime,
          },
        });

        const webhookData = {
          id: uniqueId,
          tx_ref: txRef,
          status: "successful",
          charged_amount: 5000,
          flw_ref: `FLW-EXT-IDEMPOTENT-${uniqueId}`,
          device_fingerprint: "device-extension-idempotent",
          amount: 5000,
          currency: "NGN",
          app_fee: 70,
          merchant_fee: 0,
          processor_response: "Approved",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test idempotent extension webhook",
          payment_type: "card",
          created_at: new Date().toISOString(),
          account_id: 123,
          customer: {
            id: 456,
            name: "Test User",
            phone_number: null,
            email: "test@example.com",
            created_at: new Date().toISOString(),
          },
        };

        vi.spyOn(flutterwaveService, "verifyTransaction").mockResolvedValue({
          status: "success",
          message: "Transaction verified",
          data: webhookData,
        });

        const firstResponse = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "charge.completed",
            data: webhookData,
          });
        expect(firstResponse.status).toBe(HttpStatus.OK);

        const secondResponse = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "charge.completed",
            data: webhookData,
          });
        expect(secondResponse.status).toBe(HttpStatus.OK);

        const updatedExtension = await databaseService.extension.findUnique({
          where: { id: extension.id },
        });
        expect(updatedExtension?.status).toBe("ACTIVE");
        expect(updatedExtension?.paymentStatus).toBe("PAID");

        const payments = await databaseService.payment.findMany({
          where: { txRef },
        });
        expect(payments).toHaveLength(1);

        const updatedLeg = await databaseService.bookingLeg.findUnique({
          where: { id: bookingLeg.id },
        });
        expect(updatedLeg?.legEndTime.toISOString()).toBe(extensionEndTime.toISOString());
      });
    });

    describe("transfer.completed", () => {
      let fleetOwnerId: string;

      beforeAll(async () => {
        const fleetOwner = await factory.createFleetOwner();
        fleetOwnerId = fleetOwner.id;
      });

      it("should finalize a successful transfer and emit one payout notification", async () => {
        const payoutReference = `payout-${Date.now()}`;
        const payoutTransaction = await factory.createPayoutTransaction(fleetOwnerId, {
          bookingId: testBookingId,
          status: "PROCESSING",
          payoutProviderReference: payoutReference,
        });
        const transferData = {
          id: 77777,
          reference: payoutReference,
          status: "SUCCESSFUL",
          account_number: "1234567890",
          bank_code: "044",
          full_name: "Test Fleet Owner",
          created_at: new Date().toISOString(),
          currency: "NGN",
          debit_currency: "NGN",
          amount: 45000,
          fee: 50,
          meta: {},
          narration: "Payout for booking",
          complete_message: "Transfer completed",
          requires_approval: 0,
          is_approved: 1,
          bank_name: "Access Bank",
        };
        vi.spyOn(flutterwaveService, "findTransferByReference").mockResolvedValueOnce(transferData);

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "transfer.completed",
            data: transferData,
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.status).toBe("ok");
        const duplicateResponse = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "transfer.completed",
            data: transferData,
          });
        expect(duplicateResponse.status).toBe(HttpStatus.OK);

        // Verify payout transaction was updated
        const updatedPayout = await factory.getPayoutTransactionById(payoutTransaction.id);
        expect(updatedPayout?.status).toBe("PAID_OUT");
        expect(updatedPayout?.amountPaid?.toNumber()).toBe(45000);
        expect(updatedPayout?.completedAt).toBeDefined();

        const notificationEvent = await databaseService.notificationOutboxEvent.findUnique({
          where: {
            dedupeKey: `payout-status:${payoutTransaction.id}:PAID_OUT`,
          },
        });
        expect(notificationEvent).toMatchObject({
          bookingId: testBookingId,
          status: "PENDING",
        });
        expect(notificationEvent?.payload).toMatchObject({
          subtype: "PAYOUT_PAID_OUT",
        });
        await expect(
          databaseService.notificationOutboxEvent.count({
            where: {
              dedupeKey: `payout-status:${payoutTransaction.id}:PAID_OUT`,
            },
          }),
        ).resolves.toBe(1);
      });
    });

    describe("refund.completed", () => {
      it("rejects malformed refund payloads instead of acknowledging them", async () => {
        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.completed",
            data: {
              id: 0,
              AmountRefunded: -1,
              status: "",
              FlwRef: "",
              TransactionId: 0,
            },
          });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(response.body).toMatchObject({
          errorCode: "FLUTTERWAVE_WEBHOOK_PAYLOAD_INVALID",
          title: "Invalid Flutterwave Webhook Payload",
        });
      });

      it("should update payment status to REFUNDED when refund is completed", async () => {
        // Use a unique numeric transaction ID since Flutterwave sends TransactionId as a number
        const flwTransactionId = Date.now();
        await databaseService.booking.update({
          where: { id: testBookingId },
          data: { paymentStatus: "REFUND_PROCESSING" },
        });
        const payment = await factory.createPayment(testBookingId, {
          status: "REFUND_PROCESSING",
          amountExpected: 50000,
          amountCharged: 50000,
          flutterwaveTransactionId: flwTransactionId.toString(),
          refundRequestedAmount: 50000,
          refundRequestedAt: new Date(),
        });
        const refundData = createRefundWebhookData(flwTransactionId, {
          id: 55555,
          FlwRef: "FLW-REF-REFUND",
        });
        vi.spyOn(flutterwaveService, "fetchRefund").mockResolvedValue(
          createFetchedRefund(flwTransactionId, {
            id: 55555,
            status: "completed-mpgs",
            flw_ref: "FLW-REF-REFUND",
            comment: "Customer requested refund",
            settlement_id: "settle-123",
            created_at: refundData.createdAt,
          }),
        );

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.completed",
            data: refundData,
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.status).toBe("ok");

        // Verify payment was updated
        const updatedPayment = await factory.getPaymentById(payment.id);
        expect(updatedPayment?.status).toBe("REFUNDED");
        await expect(
          databaseService.booking.findUnique({
            where: { id: testBookingId },
            select: { paymentStatus: true },
          }),
        ).resolves.toMatchObject({ paymentStatus: "REFUNDED" });

        const dedupeKey = "refund-status:55555:REFUNDED";
        const notificationEvent = await databaseService.notificationOutboxEvent.findUnique({
          where: { dedupeKey },
        });
        expect(notificationEvent).toMatchObject({
          bookingId: testBookingId,
          status: "PENDING",
        });
        expect(notificationEvent?.payload).toMatchObject({
          subtype: "REFUND_REFUNDED",
        });

        const duplicateResponse = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.completed",
            data: refundData,
          });
        expect(duplicateResponse.status).toBe(HttpStatus.OK);
        await expect(
          databaseService.notificationOutboxEvent.count({ where: { dedupeKey } }),
        ).resolves.toBe(1);
      });

      it("should atomically record an operations notification when a refund fails", async () => {
        const flwTransactionId = Date.now();
        const refundId = flwTransactionId + 1;
        await databaseService.booking.update({
          where: { id: testBookingId },
          data: { paymentStatus: "REFUND_PROCESSING" },
        });
        const payment = await factory.createPayment(testBookingId, {
          status: "REFUND_PROCESSING",
          amountExpected: 50000,
          amountCharged: 50000,
          flutterwaveTransactionId: flwTransactionId.toString(),
          refundRequestedAmount: 50000,
          refundRequestedAt: new Date(),
        });
        vi.spyOn(flutterwaveService, "fetchRefund").mockResolvedValue(
          createFetchedRefund(flwTransactionId, {
            id: refundId,
            amount_refunded: 0,
            status: "failed",
            flw_ref: "FLW-REF-FAILED",
            comment: "Provider rejected refund",
            settlement_id: "settle-failed",
          }),
        );

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.completed",
            data: createRefundWebhookData(flwTransactionId, {
              id: refundId,
              AmountRefunded: 0,
              status: "failed",
              FlwRef: "FLW-REF-FAILED",
              comments: "Provider rejected refund",
              settlement_id: "settle-failed",
            }),
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect((await factory.getPaymentById(payment.id))?.status).toBe("REFUND_FAILED");
        await expect(
          databaseService.booking.findUnique({
            where: { id: testBookingId },
            select: { paymentStatus: true },
          }),
        ).resolves.toMatchObject({ paymentStatus: "REFUND_FAILED" });

        const notificationEvent = await databaseService.notificationOutboxEvent.findUnique({
          where: {
            dedupeKey: `refund-status:${refundId}:REFUND_FAILED`,
          },
        });
        expect(notificationEvent).toMatchObject({
          bookingId: testBookingId,
          status: "PENDING",
        });
        expect(notificationEvent?.payload).toMatchObject({
          subtype: "REFUND_REFUND_FAILED",
          notificationJobData: {
            audience: "operations",
            channels: ["email"],
            templateData: {
              amount: "₦50,000.00",
            },
          },
        });
      });
    });
  });

  describe("refund reconciliation", () => {
    it("hands a refund past its provider SLA to operations exactly once", async () => {
      const flwTransactionId = Date.now().toString();
      const refundId = flwTransactionId;
      await databaseService.booking.update({
        where: { id: testBookingId },
        data: { paymentStatus: "REFUND_PROCESSING" },
      });
      const payment = await factory.createPayment(testBookingId, {
        status: "REFUND_PROCESSING",
        amountExpected: 50000,
        amountCharged: 50000,
        paymentMethod: "bank_transfer",
        flutterwaveTransactionId: flwTransactionId,
        refundProviderId: refundId,
        refundRequestedAmount: 50000,
        refundRequestedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });
      vi.spyOn(flutterwaveService, "fetchRefund").mockResolvedValue(
        createFetchedRefund(Number(flwTransactionId), {
          id: Number(flwTransactionId),
          flw_ref: `FLW-${refundId}`,
        }),
      );

      await expect(refundReconciliationService.reconcileProcessingRefunds()).resolves.toBe(1);
      await expect(refundReconciliationService.reconcileProcessingRefunds()).resolves.toBe(0);
      expect(flutterwaveService.fetchRefund).toHaveBeenCalledTimes(1);

      const updatedPayment = await factory.getPaymentById(payment.id);
      expect(updatedPayment).toMatchObject({
        status: "REFUND_PROCESSING",
        refundProviderStatus: "completed",
      });
      expect(updatedPayment?.refundManualReviewNotifiedAt).toBeInstanceOf(Date);

      await expect(
        databaseService.notificationOutboxEvent.count({
          where: {
            dedupeKey: `refund-status:${refundId}:REFUND_REVIEW_REQUIRED`,
          },
        }),
      ).resolves.toBe(1);
    });
  });
});
