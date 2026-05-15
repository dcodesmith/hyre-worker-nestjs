import { HttpStatus, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import type { CreateBookingDto } from "../src/modules/booking/dto/create-booking.dto";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlutterwaveChargeData } from "../src/modules/flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import type { ClientTypeOption } from "./helpers";
import { TestDataFactory, uniqueEmail } from "./helpers";

const ONE_DAY_MS = 86400000;
const TWELVE_HOURS_MS = 43200000;

type SameLocationCreateBookingDto = Extract<CreateBookingDto, { sameLocation: true }>;
type ExpectedReferralBooking = {
  referrerUserId: string;
  discountAmount: number;
  totalAmount: number;
};

/**
 * End-to-end test for the full booking flow:
 * Auth (OTP signup) → Create Booking → Flutterwave Webhook → Booking Confirmed
 *
 * Tests both mobile and web client authentication paths.
 * External dependencies (Flutterwave API, email) are mocked;
 * database and auth are real against test containers.
 */
describe("Booking Flow E2E", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let factory: TestDataFactory;
  let webhookSecret: string;

  // Shared test car — each test creates a fresh one to avoid status conflicts
  let fleetOwnerId: string;

  beforeAll(async () => {
    const mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);

    process.env.FLUTTERWAVE_WEBHOOK_SECRET = "test-webhook-secret";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOTPEmail })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    flutterwaveService = app.get(FlutterwaveService);
    factory = new TestDataFactory(databaseService, app);

    const configService = app.get(ConfigService);
    webhookSecret = configService.get("FLUTTERWAVE_WEBHOOK_SECRET") ?? "test-webhook-secret";

    await app.init();

    await factory.createPlatformRates();

    // Create a fleet owner (shared; each test creates its own car)
    const fleetOwner = await factory.createFleetOwner();
    fleetOwnerId = fleetOwner.id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    vi.restoreAllMocks();

    // Mock Flutterwave payment intent — each call gets a unique ID
    vi.spyOn(flutterwaveService, "createPaymentIntent").mockImplementation(async () => {
      const uniqueId = `flw_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        paymentIntentId: uniqueId,
        checkoutUrl: `https://checkout.flutterwave.com/pay/${uniqueId}`,
      };
    });
    vi.spyOn(flutterwaveService, "verifyTransaction");
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Runs the full booking flow after authentication:
   * 1. Creates a booking → asserts PENDING state
   * 2. Sends Flutterwave webhook → asserts CONFIRMED state
   */
  async function runBookingFlow(
    cookie: string,
    testCarId: string,
    overrides: Partial<SameLocationCreateBookingDto> = {},
    expectedReferral?: ExpectedReferralBooking,
  ): Promise<{ bookingId: string }> {
    const bookingPayload: SameLocationCreateBookingDto = {
      carId: testCarId,
      startDate: new Date(Date.now() + ONE_DAY_MS * 2),
      endDate: new Date(Date.now() + ONE_DAY_MS * 2 + TWELVE_HOURS_MS),
      pickupAddress: "123 Main St, Lagos",
      bookingType: "DAY",
      pickupTime: "9:00 AM",
      sameLocation: true,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      ...overrides,
    };

    const bookingResponse = await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", cookie)
      .send(bookingPayload);

    expect(bookingResponse.status).toBe(HttpStatus.CREATED);
    expect(bookingResponse.body).toHaveProperty("bookingId");
    expect(bookingResponse.body).toHaveProperty("checkoutUrl");
    expect(bookingResponse.body.checkoutUrl).toContain("checkout.flutterwave.com");

    const { bookingId } = bookingResponse.body;

    const pendingBooking = await factory.getBookingById(bookingId);

    if (!pendingBooking) throw new Error("Booking not found after creation");

    expect(pendingBooking.status).toBe("PENDING");
    expect(pendingBooking.paymentStatus).toBe("UNPAID");

    const txRef = pendingBooking.paymentIntent;
    if (!txRef) throw new Error("Booking has no paymentIntent after creation");
    const expectedAmount = pendingBooking.totalAmount.toNumber();

    // Simulate Flutterwave webhook

    const flwTransactionId = Date.now() + Math.floor(Math.random() * 100000);

    const webhookData: FlutterwaveChargeData = {
      id: flwTransactionId,
      tx_ref: txRef,
      status: "successful",
      charged_amount: expectedAmount,
      flw_ref: `FLW-FLOW-REF-${Date.now()}`,
      device_fingerprint: "device-flow-test",
      amount: expectedAmount,
      currency: "NGN",
      app_fee: 700,
      merchant_fee: 0,
      processor_response: "Approved",
      auth_model: "PIN",
      ip: "127.0.0.1",
      narration: "Booking payment",
      payment_type: "card",
      created_at: new Date().toISOString(),
      account_id: 123,
      customer: {
        id: 456,
        name: "Test Customer",
        phone_number: null,
        email: "test@example.com",
        created_at: new Date().toISOString(),
      },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "Transaction verified",
      data: webhookData,
    });

    const webhookResponse = await request(app.getHttpServer())
      .post("/api/payments/webhook/flutterwave")
      .set("verif-hash", webhookSecret)
      .send({
        event: "charge.completed",
        data: webhookData,
      });

    expect(webhookResponse.status).toBe(HttpStatus.CREATED);
    expect(webhookResponse.body.status).toBe("ok");

    // Booking should be CONFIRMED with PAID payment status
    const confirmedBooking = await factory.getBookingById(bookingId);
    if (!confirmedBooking) throw new Error("Booking not found after webhook");
    expect(confirmedBooking.status).toBe("CONFIRMED");
    expect(confirmedBooking.paymentStatus).toBe("PAID");

    if (expectedReferral) {
      expect(confirmedBooking.referralReferrerUserId).toBe(expectedReferral.referrerUserId);
      expect(confirmedBooking.referralDiscountAmount.toNumber()).toBe(
        expectedReferral.discountAmount,
      );
      expect(confirmedBooking.referralStatus).toBe("APPLIED");
      expect(confirmedBooking.totalAmount.toNumber()).toBe(expectedReferral.totalAmount);
    }

    // Payment should be SUCCESSFUL
    const successfulPayment = await factory.getPaymentByBookingId(bookingId);

    if (!successfulPayment) throw new Error("Payment not found after webhook");

    expect(successfulPayment.status).toBe("SUCCESSFUL");
    expect(successfulPayment.flutterwaveTransactionId).toBe(String(flwTransactionId));
    expect(successfulPayment.amountCharged?.toNumber()).toBe(expectedAmount);

    // Car should be BOOKED
    const bookedCar = await factory.getCarById(testCarId);

    if (!bookedCar) throw new Error("Car not found after webhook");

    expect(bookedCar.status).toBe("BOOKED");

    return { bookingId };
  }

  /**
   * Runs the full extension flow after authentication:
   * 1. Creates and confirms a base booking using the public API
   * 2. Calls booking extension endpoint
   * 3. Sends Flutterwave webhook
   * 4. Asserts extension activation and booking leg update
   */
  async function runExtensionFlow(cookie: string, testCarId: string) {
    const { bookingId } = await runBookingFlow(cookie, testCarId);

    const extendResponse = await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/extensions`)
      .set("Cookie", cookie)
      .send({
        hours: 2,
        callbackUrl: "https://example.com/extension-payment-status",
      });

    expect(extendResponse.status).toBe(HttpStatus.CREATED);
    expect(extendResponse.body).toHaveProperty("extensionId");
    expect(extendResponse.body).toHaveProperty("paymentIntentId");
    expect(extendResponse.body.checkoutUrl).toContain("checkout.flutterwave.com");

    const extensionId = extendResponse.body.extensionId as string;
    const txRef = extendResponse.body.paymentIntentId as string;

    const createdExtension = await databaseService.extension.findUnique({
      where: { id: extensionId },
    });
    if (!createdExtension) {
      throw new Error("Extension not found right after extension endpoint");
    }
    const extensionAmount = createdExtension.totalAmount.toNumber();
    const extensionEndTime = new Date(createdExtension.extensionEndTime);

    const flwTransactionId = Date.now() + Math.floor(Math.random() * 100000);
    const webhookData: FlutterwaveChargeData = {
      id: flwTransactionId,
      tx_ref: txRef,
      status: "successful",
      charged_amount: extensionAmount,
      flw_ref: `FLW-EXT-FLOW-REF-${Date.now()}`,
      device_fingerprint: "device-extension-flow",
      amount: extensionAmount,
      currency: "NGN",
      app_fee: 70,
      merchant_fee: 0,
      processor_response: "Approved",
      auth_model: "PIN",
      ip: "127.0.0.1",
      narration: "Extension payment",
      payment_type: "card",
      created_at: new Date().toISOString(),
      account_id: 123,
      customer: {
        id: 456,
        name: "Test Customer",
        phone_number: null,
        email: "test@example.com",
        created_at: new Date().toISOString(),
      },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "Transaction verified",
      data: webhookData,
    });

    const webhookResponse = await request(app.getHttpServer())
      .post("/api/payments/webhook/flutterwave")
      .set("verif-hash", webhookSecret)
      .send({
        event: "charge.completed",
        data: webhookData,
      });

    expect(webhookResponse.status).toBe(HttpStatus.CREATED);
    expect(webhookResponse.body.status).toBe("ok");

    const updatedExtension = await databaseService.extension.findUnique({
      where: { id: extensionId },
    });
    if (!updatedExtension) throw new Error("Extension not found after webhook");
    expect(updatedExtension.status).toBe("ACTIVE");
    expect(updatedExtension.paymentStatus).toBe("PAID");
    expect(updatedExtension.paymentId).toBeTruthy();

    const updatedLeg = await databaseService.bookingLeg.findUnique({
      where: { id: createdExtension.bookingLegId },
    });
    if (!updatedLeg) throw new Error("Booking leg not found after webhook");
    expect(updatedLeg.legEndTime.toISOString()).toBe(extensionEndTime.toISOString());

    const extensionPayment = await databaseService.payment.findFirst({
      where: { txRef },
    });
    if (!extensionPayment) throw new Error("Extension payment record not found after webhook");
    expect(extensionPayment.status).toBe("SUCCESSFUL");
    expect(extensionPayment.extensionId).toBe(extensionId);
    expect(extensionPayment.flutterwaveTransactionId).toBe(String(flwTransactionId));
  }

  describe.each<{ clientType: ClientTypeOption; label: string }>([
    { clientType: "mobile", label: "Mobile client" },
    { clientType: "web", label: "Web client" },
  ])("$label - full booking flow", ({ clientType }) => {
    it("should authenticate referrer and referee, apply referral discount, process payment webhook, and confirm booking", async () => {
      // Create a fresh car for this test (avoids status conflicts between tests)
      const car = await factory.createCar(fleetOwnerId);

      // User A signs up first and is auto-assigned a referral code
      const { user: userA } = await factory.authenticateAndGetUser(
        uniqueEmail(`referrer-flow-${clientType}`),
        "user",
        clientType,
      );

      // User B signs up using User A's referral code
      const { cookie, user: userB } = await factory.authenticateAndGetUser(
        uniqueEmail(`referred-flow-${clientType}`),
        "user",
        clientType,
        { referralCode: userA.referralCode },
      );
      expect(userB.referredByUserId).toBe(userA.id);

      await factory.enableReferralProgram();

      // 20% car-specific promotion covering the booking window
      await factory.createPromotion(fleetOwnerId, { carId: car.id, discountValue: 20 });

      // Pin start to 9 AM local so the 12-hour DAY booking falls within a single
      // calendar day (1 leg) regardless of when the test runs. DAY bookings
      // generate one leg per calendar day, so a window crossing midnight would
      // produce 2 legs and double the expected price.
      const startDate = new Date(Date.now() + ONE_DAY_MS * 2);
      startDate.setHours(9, 0, 0, 0);
      const endDate = new Date(startDate.getTime() + TWELVE_HOURS_MS);

      // Pricing preview should reflect both the promotion and the referral discount.
      // Math (1 DAY leg @ dayRate 50,000, 10% platform fee, 7.5% VAT):
      //   compare-at: 50,000 + 5,000 fee = 55,000 subtotal → +4,125 VAT → 59,125
      //   after 20% promo: 40,000 + 4,000 fee = 44,000 subtotal
      //   after referral: 44,000 − 10,000 = 34,000 → +2,550 VAT → 36,550 total
      //   savings: 59,125 − 36,550 = 22,575
      const previewResponse = await request(app.getHttpServer())
        .post("/api/bookings/pricing-preview")
        .set("Cookie", cookie)
        .send({
          carId: car.id,
          bookingType: "DAY",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          pickupTime: "9:00 AM",
          includeSecurityDetail: false,
          requiresFullTank: false,
        });
      expect(previewResponse.status).toBe(HttpStatus.OK);

      // Per-leg base (after promo) and compare-at (before promo)
      expect(previewResponse.body.baseTotal).toBe(40000);
      expect(previewResponse.body.compareAtBaseTotal).toBe(50000);

      // Platform fee (10% of leg net)
      expect(previewResponse.body.platformFeeAmount).toBe(4000);
      expect(previewResponse.body.compareAtPlatformFeeAmount).toBe(5000);

      // Subtotal before referral discount (after promotion)
      expect(previewResponse.body.subtotalBeforeDiscounts).toBe(44000);
      expect(previewResponse.body.compareAtSubtotalBeforeDiscounts).toBe(55000);

      // Referral discount applied
      expect(previewResponse.body.referralDiscountAmount).toBe(10000);
      expect(previewResponse.body.subtotalAfterDiscounts).toBe(34000);

      // VAT (7.5%) on subtotalAfterDiscounts vs compareAtSubtotalBeforeDiscounts
      expect(previewResponse.body.vatAmount).toBe(2550);
      expect(previewResponse.body.compareAtVatAmount).toBe(4125);

      // Final totals + combined savings (promo + referral, including their VAT impact)
      expect(previewResponse.body.totalAmount).toBe(36550);
      expect(previewResponse.body.compareAtTotalAmount).toBe(59125);
      expect(previewResponse.body.savingsAmount).toBe(22575);
      expect(previewResponse.body.discountCoverage).toBe("FULL");

      // Booking creation + payment webhook must persist the same discount and total
      await runBookingFlow(
        cookie,
        car.id,
        {
          startDate,
          endDate,
          clientTotalAmount: String(previewResponse.body.totalAmount),
        },
        {
          referrerUserId: userA.id,
          discountAmount: 10000,
          totalAmount: 36550,
        },
      );
    });

    it("should initialize extension payment, process webhook, and activate extension", async () => {
      const car = await factory.createCar(fleetOwnerId);

      const email = uniqueEmail(`extension-flow-${clientType}`);
      const { cookie } = await factory.authenticateAndGetUser(email, "user", clientType);
      await runExtensionFlow(cookie, car.id);
    });
  });
});
