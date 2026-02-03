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
import { DatabaseService } from "../src/modules/database/database.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Payments E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
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

    it("should reject payment for non-existent booking", async () => {
      // Use a valid CUID format that doesn't exist in the database
      const nonExistentCuid = "cm5nonexistent00000000001";

      const response = await request(app.getHttpServer())
        .post("/api/payments/initialize")
        .set("Cookie", testUserCookie)
        .send({
          type: "booking",
          entityId: nonExistentCuid,
          amount: 50000,
          callbackUrl: "https://example.com/callback",
        });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.message).toBe("Booking not found");
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

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.status).toBe("ok");
      });
    });

    describe("charge.completed", () => {
      it("should create payment with SUCCESSFUL status when charge is successful", async () => {
        const txRef = `tx-charge-success-${Date.now()}`;
        const uniqueId = Date.now() + Math.floor(Math.random() * 100000);

        // Create a booking with paymentIntent matching the tx_ref
        const booking = await factory.createBookingWithDependencies(testUserId, {
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
          flw_ref: `FLW-MOCK-REF-${uniqueId}`,
          device_fingerprint: "device-123",
          amount: 50000,
          currency: "NGN",
          app_fee: 700,
          merchant_fee: 0,
          processor_response: "Approved",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test payment",
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

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.status).toBe("ok");

        // Verify payment was created by the webhook handler
        const payment = await factory.getPaymentByBookingId(booking.id);
        expect(payment).toBeDefined();
        expect(payment?.status).toBe("SUCCESSFUL");
        expect(payment?.flutterwaveTransactionId).toBe(String(uniqueId));
        expect(payment?.amountCharged?.toNumber()).toBe(50000);
      });

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

        expect(response.status).toBe(HttpStatus.CREATED);
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

        expect(response.status).toBe(HttpStatus.CREATED);

        // Verify booking was NOT confirmed (still PENDING)
        const unchangedBooking = await factory.getBookingById(pendingBooking.id);
        expect(unchangedBooking?.status).toBe("PENDING");
        expect(unchangedBooking?.paymentStatus).toBe("UNPAID");
      });

      it("should handle idempotency - skip already processed payment", async () => {
        const txRef = `tx-idempotent-${Date.now()}`;
        const originalTransactionId = `FLW-IDEMPOTENT-${Date.now()}`;

        // Create a booking with paymentIntent and a pre-existing SUCCESSFUL payment
        const booking = await factory.createBookingWithDependencies(testUserId, {
          booking: {
            status: "CONFIRMED",
            paymentStatus: "PAID",
            paymentIntent: txRef,
            totalAmount: 50000,
          },
        });

        const payment = await factory.createPayment(booking.id, {
          txRef,
          status: PaymentAttemptStatus.SUCCESSFUL,
          amountExpected: 50000,
          amountCharged: 50000,
          flutterwaveTransactionId: originalTransactionId,
          confirmedAt: new Date(Date.now() - 60000),
        });

        const idempotentId = Date.now() + Math.floor(Math.random() * 100000) + 3;
        const webhookData = {
          id: idempotentId,
          tx_ref: txRef,
          status: "successful",
          charged_amount: 50000,
          flw_ref: `FLW-IDEMPOTENT-REF-${idempotentId}`,
          device_fingerprint: "device-123",
          amount: 50000,
          currency: "NGN",
          app_fee: 700,
          merchant_fee: 0,
          processor_response: "Approved",
          auth_model: "PIN",
          ip: "127.0.0.1",
          narration: "Test payment",
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

        expect(response.status).toBe(HttpStatus.CREATED);

        // Verify the payment wasn't modified (upsert's update: {} is a no-op)
        // flutterwaveTransactionId should still be the original value, not "88888"
        const unchangedPayment = await factory.getPaymentById(payment.id);
        expect(unchangedPayment?.flutterwaveTransactionId).toBe(originalTransactionId);
        expect(unchangedPayment?.status).toBe("SUCCESSFUL");
      });
    });

    describe("transfer.completed", () => {
      let fleetOwnerId: string;

      beforeAll(async () => {
        const fleetOwner = await factory.createFleetOwner();
        fleetOwnerId = fleetOwner.id;
      });

      it("should update payout transaction status to PAID_OUT when transfer is successful", async () => {
        const payoutReference = `payout-${Date.now()}`;
        const payoutTransaction = await factory.createPayoutTransaction(fleetOwnerId, {
          bookingId: testBookingId,
          status: "PROCESSING",
          payoutProviderReference: payoutReference,
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "transfer.completed",
            data: {
              id: 77777,
              reference: payoutReference,
              status: "SUCCESSFUL", // Flutterwave uses uppercase for transfer statuses
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
            },
          });

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.status).toBe("ok");

        // Verify payout transaction was updated
        const updatedPayout = await factory.getPayoutTransactionById(payoutTransaction.id);
        expect(updatedPayout?.status).toBe("PAID_OUT");
        expect(updatedPayout?.completedAt).toBeDefined();
      });

      it("should update payout transaction status to FAILED when transfer fails", async () => {
        const payoutReference = `payout-failed-${Date.now()}`;
        const payoutTransaction = await factory.createPayoutTransaction(fleetOwnerId, {
          bookingId: testBookingId,
          status: "PROCESSING",
          payoutProviderReference: payoutReference,
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "transfer.completed",
            data: {
              id: 66666,
              reference: payoutReference,
              status: "FAILED",
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
              complete_message: "Transfer failed",
              requires_approval: 0,
              is_approved: 1,
              bank_name: "Access Bank",
            },
          });

        expect(response.status).toBe(HttpStatus.CREATED);

        // Verify payout transaction was marked as failed
        const updatedPayout = await factory.getPayoutTransactionById(payoutTransaction.id);
        expect(updatedPayout?.status).toBe("FAILED");
      });
    });

    describe("refund.completed", () => {
      it("should update payment status to REFUNDED when refund is completed", async () => {
        // Use a unique numeric transaction ID since Flutterwave sends TransactionId as a number
        const flwTransactionId = Date.now() + Math.floor(Math.random() * 100000);
        const payment = await factory.createPayment(testBookingId, {
          status: "REFUND_PROCESSING",
          amountExpected: 50000,
          amountCharged: 50000,
          flutterwaveTransactionId: flwTransactionId.toString(),
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.completed",
            data: {
              id: 55555,
              AmountRefunded: 50000,
              status: "completed",
              FlwRef: "FLW-REF-REFUND",
              destination: "card",
              comments: "Customer requested refund",
              settlement_id: "settle-123",
              meta: "{}",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              walletId: 789,
              AccountId: 123,
              TransactionId: flwTransactionId,
            },
          });

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.status).toBe("ok");

        // Verify payment was updated
        const updatedPayment = await factory.getPaymentById(payment.id);
        expect(updatedPayment?.status).toBe("REFUNDED");
      });

      it("should update payment status to PARTIALLY_REFUNDED for partial refunds", async () => {
        // Use a numeric transaction ID since Flutterwave sends TransactionId as a number
        const flwTransactionId = Math.floor(Date.now() / 1000) + 1;
        const payment = await factory.createPayment(testBookingId, {
          status: "REFUND_PROCESSING",
          amountExpected: 50000,
          amountCharged: 50000,
          flutterwaveTransactionId: flwTransactionId.toString(),
        });

        const response = await request(app.getHttpServer())
          .post("/api/payments/webhook/flutterwave")
          .set("verif-hash", webhookSecret)
          .send({
            event: "refund.completed",
            data: {
              id: 44444,
              AmountRefunded: 25000, // Partial refund
              status: "completed",
              FlwRef: "FLW-REF-PARTIAL",
              destination: "card",
              comments: "Partial refund",
              settlement_id: "settle-456",
              meta: "{}",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              walletId: 789,
              AccountId: 123,
              TransactionId: flwTransactionId,
            },
          });

        expect(response.status).toBe(HttpStatus.CREATED);

        // Verify payment was marked as partially refunded
        const updatedPayment = await factory.getPaymentById(payment.id);
        expect(updatedPayment?.status).toBe("PARTIALLY_REFUNDED");
      });
    });
  });
});
