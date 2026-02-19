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
  async function runBookingFlow(cookie: string, testCarId: string): Promise<{ bookingId: string }> {
    const bookingPayload: CreateBookingDto = {
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
    it("should authenticate, create booking, process payment webhook, and confirm booking", async () => {
      // Create a fresh car for this test (avoids status conflicts between tests)
      const car = await factory.createCar(fleetOwnerId);

      // Authenticate via the appropriate client type
      const email = uniqueEmail(`flow-${clientType}`);
      const { cookie } = await factory.authenticateAndGetUser(email, "user", clientType);

      await runBookingFlow(cookie, car.id);
    });

    it("should initialize extension payment, process webhook, and activate extension", async () => {
      const car = await factory.createCar(fleetOwnerId);

      const email = uniqueEmail(`extension-flow-${clientType}`);
      const { cookie } = await factory.authenticateAndGetUser(email, "user", clientType);
      await runExtensionFlow(cookie, car.id);
    });
  });
});
