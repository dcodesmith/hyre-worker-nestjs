import { randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import {
  BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS,
  EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS,
} from "../src/modules/booking/booking.const";
import { DatabaseService } from "../src/modules/database/database.service";
import { EmailService } from "../src/modules/email/email.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { MapsService } from "../src/modules/maps/maps.service";
import { renderGuestBookingAccessEmail } from "../src/templates/emails";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Bookings E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let mapsService: MapsService;
  let factory: TestDataFactory;
  const emailService = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

  let testUserCookie: string;
  let testUserId: string;
  let testCarId: string;
  let fleetOwnerId: string;

  beforeAll(async () => {
    const mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOTPEmail })
      .overrideProvider(EmailService)
      .useValue(emailService)
      .compile();

    app = moduleFixture.createNestApplication({
      logger: false,
    });

    databaseService = app.get(DatabaseService);
    flutterwaveService = app.get(FlutterwaveService);
    mapsService = app.get(MapsService);
    factory = new TestDataFactory(databaseService, app);

    await app.init();

    await factory.createPlatformRates();

    // Create test user
    const testEmail = uniqueEmail("booking-test-user");
    const testResult = await factory.authenticateAndGetUser(testEmail, "user");
    testUserCookie = testResult.cookie;
    testUserId = testResult.user.id;

    // Create fleet owner and car
    const fleetOwner = await factory.createFleetOwner();
    fleetOwnerId = fleetOwner.id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    vi.restoreAllMocks();
    emailService.sendEmail.mockClear();
    vi.mocked(renderGuestBookingAccessEmail).mockImplementation(({ accessUrl }) =>
      Promise.resolve(`<a href="${accessUrl}">View booking</a>`),
    );
    testCarId = (await factory.createCar(fleetOwnerId)).id;

    // Mock payment intent creation for all booking tests
    vi.spyOn(flutterwaveService, "createPaymentIntent").mockResolvedValue({
      paymentIntentId: "flw_pi_123",
      checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
    });

    // Mock maps service for any airport-related calculations
    vi.spyOn(mapsService, "calculateAirportTripDuration").mockResolvedValue({
      durationMinutes: 45,
      distanceMeters: 25000,
      isEstimate: false,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/bookings", () => {
    let bookingSequence = 0;
    const createValidBookingPayload = async (
      carId: string,
      cookie?: string,
      { allowPreviewFailure = false }: { allowPreviewFailure?: boolean } = {},
    ) => {
      const dayOffset = 2 + bookingSequence++ * 3;
      const payload = {
        carId,
        startDate: new Date(Date.now() + 86400000 * dayOffset).toISOString(),
        endDate: new Date(Date.now() + 86400000 * dayOffset + 43200000).toISOString(),
        pickupAddress: "123 Main St, Lagos",
        bookingType: "DAY",
        pickupTime: "9:00 AM",
        sameLocation: true,
        includeSecurityDetail: false,
        requiresFullTank: false,
        useCredits: 0,
      };
      const previewRequest = request(app.getHttpServer())
        .post("/api/bookings/pricing-preview")
        .send(payload);
      if (cookie) previewRequest.set("Cookie", cookie);
      const preview = await previewRequest;
      if (!allowPreviewFailure) {
        expect(preview.status).toBe(HttpStatus.OK);
      }
      return {
        ...payload,
        expectedTotalAmount:
          preview.status === HttpStatus.OK ? String(preview.body.totalAmount) : "0",
      };
    };

    const createGuestBookingPayload = async (carId: string, guestEmail = "guest@example.com") => ({
      ...(await createValidBookingPayload(carId)),
      guestEmail,
      guestName: "Guest User",
      guestPhone: "08012345678",
    });

    describe("Authenticated User Bookings", () => {
      it("requires Idempotency-Key", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(response.body.errorCode).toBe("VALIDATION_ERROR");
      });

      it("should create a booking for authenticated user", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body).toHaveProperty("bookingId");
        expect(response.body).toHaveProperty("checkoutUrl");
        expect(response.body).toEqual(
          expect.objectContaining({
            txRef: expect.any(String),
            totalAmount: Number(payload.expectedTotalAmount),
            currency: "NGN",
            bookingStatus: "PENDING",
            reservationExpiresAt: expect.any(String),
          }),
        );
        expect(response.body.checkoutUrl).toContain("checkout.flutterwave.com");
      });

      it("reconciles an expired unpaid booking before returning payment status", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);
        const created = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);
        expect(created.status).toBe(HttpStatus.CREATED);

        const booking = await databaseService.booking.update({
          where: { id: created.body.bookingId as string },
          data: { paymentSessionExpiresAt: new Date(Date.now() - 1_000) },
          select: { id: true, paymentIntent: true },
        });
        vi.spyOn(flutterwaveService, "findTransactionByReference").mockResolvedValue(null);

        const response = await request(app.getHttpServer())
          .post("/api/payments/booking-expiration")
          .set("Cookie", testUserCookie)
          .send({
            bookingId: booking.id,
            txRef: booking.paymentIntent,
          });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body).toEqual(
          expect.objectContaining({
            bookingId: booking.id,
            bookingStatus: "CANCELLED",
            paymentStatus: "UNPAID",
            lifecycleState: "EXPIRED",
          }),
        );
      });

      it("returns current pricing when the accepted price is stale", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send({ ...payload, expectedTotalAmount: "0" });

        expect(response.status).toBe(HttpStatus.CONFLICT);
        expect(response.body.errorCode).toBe("BOOKING_PRICE_CHANGED");
        expect(response.body.details.currentPricing).toEqual(
          expect.objectContaining({
            totalAmount: Number(payload.expectedTotalAmount),
            currency: "NGN",
          }),
        );
      });

      it("replays the original response without initializing payment twice", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);
        const idempotencyKey = randomUUID();
        const send = () =>
          request(app.getHttpServer())
            .post("/api/bookings")
            .set("Cookie", testUserCookie)
            .set("Idempotency-Key", idempotencyKey)
            .send(payload);

        const first = await send();
        const replay = await send();

        expect(first.status).toBe(HttpStatus.CREATED);
        expect(replay.status).toBe(HttpStatus.CREATED);
        expect(replay.body).toEqual(first.body);
        expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledTimes(1);
      });

      it("rejects reuse of a key with different normalized input", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);
        const idempotencyKey = randomUUID();
        const first = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", idempotencyKey)
          .send(payload);
        const reused = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", idempotencyKey)
          .send({ ...payload, specialRequests: "Different request" });

        expect(first.status).toBe(HttpStatus.CREATED);
        expect(reused.status).toBe(HttpStatus.CONFLICT);
        expect(reused.body.errorCode).toBe("IDEMPOTENCY_KEY_REUSED");
      });

      it("prevents a different key from creating an overlapping pending booking", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);
        const first = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);
        const overlapping = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);

        expect(first.status).toBe(HttpStatus.CREATED);
        expect(overlapping.status).toBe(HttpStatus.CONFLICT);
        expect(overlapping.body.errorCode).toBe("CAR_NOT_AVAILABLE");
      });

      it("enforces overlapping reservations at the database boundary", async () => {
        const startDate = new Date(Date.now() + 300 * 86400000);
        const endDate = new Date(startDate.getTime() + 43200000);
        await factory.createBooking(testUserId, testCarId, {
          startDate,
          endDate,
          bookingReference: `DB-RESERVATION-${randomUUID()}`,
        });

        await expect(
          factory.createBooking(testUserId, testCarId, {
            startDate,
            endDate,
            bookingReference: `DB-CONFLICT-${randomUUID()}`,
          }),
        ).rejects.toThrow();
      });

      it("allows exactly two hours between reservations at the database boundary", async () => {
        const firstStartDate = new Date(Date.now() + 330 * 86400000);
        const firstEndDate = new Date(firstStartDate.getTime() + 43200000);
        const secondStartDate = new Date(firstEndDate.getTime() + 2 * 60 * 60 * 1000);
        const secondEndDate = new Date(secondStartDate.getTime() + 43200000);

        await factory.createBooking(testUserId, testCarId, {
          startDate: firstStartDate,
          endDate: firstEndDate,
          bookingReference: `DB-BUFFER-FIRST-${randomUUID()}`,
        });

        await expect(
          factory.createBooking(testUserId, testCarId, {
            startDate: secondStartDate,
            endDate: secondEndDate,
            bookingReference: `DB-BUFFER-SECOND-${randomUUID()}`,
          }),
        ).resolves.toBeDefined();
      });

      it("allows only one concurrent identical request to initialize payment", async () => {
        const payload = await createValidBookingPayload(testCarId, testUserCookie);
        const idempotencyKey = randomUUID();
        const bookingCountBefore = await databaseService.booking.count({
          where: { carId: testCarId },
        });
        let signalStarted!: () => void;
        let releasePayment!: () => void;
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        const paymentGate = new Promise<void>((resolve) => {
          releasePayment = resolve;
        });
        vi.mocked(flutterwaveService.createPaymentIntent).mockImplementationOnce(async () => {
          signalStarted();
          await paymentGate;
          return {
            paymentIntentId: "flw_pi_concurrent",
            checkoutUrl: "https://checkout.flutterwave.com/pay/concurrent",
          };
        });
        const firstPromise = request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", idempotencyKey)
          .send(payload)
          .then((response) => response);
        await started;
        const concurrent = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", idempotencyKey)
          .send(payload);
        releasePayment();
        const first = await firstPromise;

        expect(first.status).toBe(HttpStatus.CREATED);
        expect(concurrent.status).toBe(HttpStatus.CONFLICT);
        expect(concurrent.body.errorCode).toBe("BOOKING_REQUEST_IN_PROGRESS");
        expect(concurrent.headers["retry-after"]).toBe(
          String(BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS),
        );
        expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledTimes(1);
        expect(
          await databaseService.booking.count({
            where: { carId: testCarId },
          }),
        ).toBe(bookingCountBefore + 1);
      });

      it("should return 404 for non-existent car", async () => {
        const payload = await createValidBookingPayload("non-existent-car-id", testUserCookie, {
          allowPreviewFailure: true,
        });

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);

        expect(response.status).toBe(HttpStatus.NOT_FOUND);
      });
    });

    describe("Guest Bookings", () => {
      it("should create a booking for guest user", async () => {
        const payload = await createGuestBookingPayload(testCarId);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Idempotency-Key", randomUUID())
          .send(payload);

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body).toHaveProperty("bookingId");
        expect(response.body).toHaveProperty("checkoutUrl");
      });
    });

    describe("Payment Integration", () => {
      it("should return valid checkout URL on success", async () => {
        const mockCheckoutUrl = "https://checkout.flutterwave.com/pay/unique123";
        vi.spyOn(flutterwaveService, "createPaymentIntent").mockResolvedValueOnce({
          paymentIntentId: "flw_pi_unique",
          checkoutUrl: mockCheckoutUrl,
        });

        const payload = await createValidBookingPayload(testCarId, testUserCookie);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.checkoutUrl).toBe(mockCheckoutUrl);
      });

      it("should handle payment intent creation failure gracefully", async () => {
        vi.spyOn(flutterwaveService, "createPaymentIntent").mockRejectedValueOnce(
          new Error("Payment provider unavailable"),
        );

        const payload = await createValidBookingPayload(testCarId, testUserCookie);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .set("Idempotency-Key", randomUUID())
          .send(payload);

        expect(response.status).toBeGreaterThanOrEqual(HttpStatus.BAD_REQUEST);
      });
    });
  });

  describe("guest booking access", () => {
    it("emails an opaque link and returns a redacted booking", async () => {
      const guestEmail = uniqueEmail("guest-booking-access");
      const booking = await databaseService.booking.create({
        data: {
          carId: testCarId,
          userId: null,
          guestUser: {
            email: guestEmail,
            name: "Guest User",
            phoneNumber: "08012345678",
          },
          bookingReference: `GUEST-${randomUUID()}`.toUpperCase(),
          startDate: new Date(Date.now() + 20 * 86400000),
          endDate: new Date(Date.now() + 20 * 86400000 + 43200000),
          totalAmount: 50_000,
          pickupLocation: "Lagos",
          returnLocation: "Lekki",
        },
        select: { id: true, bookingReference: true },
      });

      const accessRequest = await request(app.getHttpServer())
        .post("/api/bookings/guest-access")
        .send({ bookingReference: booking.bookingReference, email: guestEmail });

      expect(accessRequest.status).toBe(HttpStatus.ACCEPTED);
      expect(accessRequest.body).toEqual({
        message: "If those booking details match, we sent an access link to the booking email.",
      });
      await vi.waitFor(
        async () => {
          const stored = await databaseService.booking.findUniqueOrThrow({
            where: { id: booking.id },
            select: { guestAccessTokenHash: true },
          });
          expect(stored.guestAccessTokenHash).toEqual(expect.any(String));
        },
        { timeout: 5_000 },
      );
      const subject = `View booking ${booking.bookingReference}`;
      await vi.waitFor(
        () =>
          expect(
            emailService.sendEmail.mock.calls.some(([email]) => email.subject === subject),
          ).toBe(true),
        { timeout: 5_000 },
      );
      const accessEmail = emailService.sendEmail.mock.calls.find(
        ([email]) => email.subject === subject,
      )?.[0];
      const token = String(accessEmail?.html).match(/token=([A-Za-z0-9_-]{43})/)?.[1];
      expect(token).toBeDefined();

      const details = await request(app.getHttpServer())
        .get("/api/bookings/guest-access")
        .query({ token });

      expect(details.status).toBe(HttpStatus.OK);
      expect(details.body).toMatchObject({
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
        bookingType: "DAY",
        currency: "NGN",
        car: { images: expect.any(Array) },
        legs: expect.any(Array),
      });
      expect(details.body).not.toHaveProperty("guestUser");
      expect(details.body).not.toHaveProperty("paymentIntent");
    });

    it("claims previous guest bookings after verified customer sign-in", async () => {
      const guestEmail = uniqueEmail("guest-booking-claim");
      const booking = await databaseService.booking.create({
        data: {
          carId: testCarId,
          userId: null,
          guestUser: {
            email: guestEmail,
            name: "Guest User",
            phoneNumber: "08012345678",
          },
          bookingReference: `GUEST-${randomUUID()}`,
          startDate: new Date(Date.now() + 30 * 86400000),
          endDate: new Date(Date.now() + 30 * 86400000 + 43200000),
          totalAmount: 50_000,
          pickupLocation: "Lagos",
          returnLocation: "Lekki",
          status: "CONFIRMED",
          paymentStatus: "PAID",
        },
        select: { id: true },
      });
      const deletedBooking = await databaseService.booking.create({
        data: {
          carId: testCarId,
          userId: null,
          guestUser: { email: guestEmail, name: "Guest User" },
          bookingReference: `DELETED-GUEST-${randomUUID()}`,
          startDate: new Date(Date.now() + 35 * 86400000),
          endDate: new Date(Date.now() + 35 * 86400000 + 43200000),
          totalAmount: 50_000,
          pickupLocation: "Lagos",
          returnLocation: "Lekki",
          status: "CONFIRMED",
          paymentStatus: "PAID",
          deletedAt: new Date(),
        },
        select: { id: true },
      });

      const authenticated = await factory.authenticateAndGetUser(guestEmail, "user");

      await expect(
        databaseService.booking.findUniqueOrThrow({
          where: { id: booking.id },
          select: { userId: true },
        }),
      ).resolves.toEqual({ userId: authenticated.user.id });
      await expect(
        databaseService.booking.findUniqueOrThrow({
          where: { id: deletedBooking.id },
          select: { userId: true },
        }),
      ).resolves.toEqual({ userId: null });
      const bookings = await request(app.getHttpServer())
        .get("/api/bookings")
        .set("Cookie", authenticated.cookie);
      expect(bookings.status).toBe(HttpStatus.OK);
      expect(bookings.body.CONFIRMED.some((item: { id: string }) => item.id === booking.id)).toBe(
        true,
      );
    });
  });

  describe("GET /api/bookings", () => {
    it("should return 401 without authentication", async () => {
      const response = await request(app.getHttpServer()).get("/api/bookings");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should return bookings grouped by status for authenticated user", async () => {
      const futureStart = new Date(Date.now() + 86400000 * 3);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });

      const response = await request(app.getHttpServer())
        .get("/api/bookings")
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toBeTypeOf("object");
      expect(response.body.CONFIRMED).toBeInstanceOf(Array);
      expect(response.body.CONFIRMED.length).toBeGreaterThanOrEqual(1);
      const listedBooking = response.body.CONFIRMED.find(
        (item: { id: string }) => item.id === booking.id,
      );
      expect(listedBooking).toMatchObject({
        canEdit: true,
        canCancel: true,
        policyHoursBeforeStart: 12,
      });
      expect(listedBooking.modificationCutoffAt).toBe(
        new Date(futureStart.getTime() - 12 * 60 * 60 * 1000).toISOString(),
      );
    });

    it("should not return another user's bookings", async () => {
      const otherUser = await factory.createUser();
      await factory.createBooking(otherUser.id, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        bookingReference: `OTHER-${Date.now()}`,
      });

      const response = await request(app.getHttpServer())
        .get("/api/bookings")
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      const allBookings = Object.values(response.body).flat() as Array<{ userId: string }>;
      for (const booking of allBookings) {
        expect(booking.userId).toBe(testUserId);
      }
    });
  });

  describe("GET /api/bookings/:bookingId", () => {
    it("should return 401 without authentication", async () => {
      const response = await request(app.getHttpServer()).get("/api/bookings/some-id");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should return booking details for the owner", async () => {
      const futureStart = new Date(Date.now() + 86400000 * 3);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.id).toBe(booking.id);
      expect(response.body).toMatchObject({
        canEdit: true,
        canCancel: true,
        modificationCutoffAt: new Date(futureStart.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        policyHoursBeforeStart: 12,
      });
    });

    it("should return 404 for non-existent booking", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/bookings/non-existent-id")
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it("should return 404 when accessing another user's booking", async () => {
      const otherUser = await factory.createUser();
      const otherBooking = await factory.createBooking(otherUser.id, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${otherBooking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe("PATCH /api/bookings/:bookingId", () => {
    it("should return 401 without authentication", async () => {
      const response = await request(app.getHttpServer())
        .patch("/api/bookings/some-id")
        .send({ pickupAddress: "New Address" });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should update booking pickup address", async () => {
      const futureStart = new Date(Date.now() + 86400000 * 3);
      const futureEnd = new Date(futureStart.getTime() + 43200000);

      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: futureEnd,
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie)
        .send({ pickupAddress: "456 Updated St, Lagos" });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toMatchObject({
        canEdit: true,
        canCancel: true,
        modificationCutoffAt: new Date(futureStart.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        policyHoursBeforeStart: 12,
      });
    });

    it("should reject updates outside the modification window", async () => {
      const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie)
        .send({ pickupAddress: "Too Late Address" });

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.body.errorCode).toBe("BOOKING_OUTSIDE_MODIFICATION_WINDOW");
      expect(response.body.details).toEqual({
        modificationCutoffAt: new Date(futureStart.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        policyHoursBeforeStart: 12,
      });
    });

    it("should reject updates for non-confirmed bookings", async () => {
      const futureStart = new Date(Date.now() + 86400000 * 3);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "ACTIVE",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie)
        .send({ pickupAddress: "Not Allowed Address" });

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.body.errorCode).toBe("BOOKING_STATUS_NOT_MODIFIABLE");
    });

    it("should return 400 for empty update body", async () => {
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie)
        .send({});

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should return 404 when updating another user's booking", async () => {
      const otherUser = await factory.createUser();
      const otherBooking = await factory.createBooking(otherUser.id, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${otherBooking.id}`)
        .set("Cookie", testUserCookie)
        .send({ pickupAddress: "Hijacked Address" });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe("PATCH /api/bookings/:bookingId/cancel", () => {
    it("should return 401 without authentication", async () => {
      const response = await request(app.getHttpServer())
        .patch("/api/bookings/some-id/cancel")
        .send({ reason: "test" });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should cancel a confirmed booking", async () => {
      const futureStart = new Date(Date.now() + 86400000 * 3);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });
      const referrer = await factory.createUser({
        email: uniqueEmail("cancelled-booking-referrer"),
      });
      await databaseService.booking.update({
        where: { id: booking.id },
        data: {
          referralReferrerUserId: referrer.id,
          referralStatus: "APPLIED",
          referralDiscountAmount: 5000,
        },
      });
      const reward = await databaseService.referralReward.create({
        data: {
          referrerUserId: referrer.id,
          refereeUserId: testUserId,
          bookingId: booking.id,
          amount: 2500,
          status: "PENDING",
          releaseCondition: "COMPLETED",
        },
      });
      await databaseService.userReferralStats.create({
        data: {
          userId: referrer.id,
          totalReferrals: 1,
          totalRewardsPending: 2500,
        },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}/cancel`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Plans changed" });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toMatchObject({
        canEdit: false,
        canCancel: false,
        modificationCutoffAt: new Date(futureStart.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        policyHoursBeforeStart: 12,
      });

      const cancelled = await factory.getBookingById(booking.id);
      expect(cancelled?.status).toBe("CANCELLED");
      expect(cancelled?.referralStatus).toBe("APPLIED");
      await expect(
        databaseService.referralReward.findUniqueOrThrow({ where: { id: reward.id } }),
      ).resolves.toMatchObject({
        status: "REVERSED",
        reason: "BOOKING_CANCELLED",
        processedAt: expect.any(Date),
      });
      const stats = await databaseService.userReferralStats.findUniqueOrThrow({
        where: { userId: referrer.id },
      });
      expect(stats.totalReferrals).toBe(0);
      expect(stats.totalRewardsPending.toString()).toBe("0");
    });

    it("should reject cancellation outside the modification window", async () => {
      const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}/cancel`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Too late" });

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.body.errorCode).toBe("BOOKING_OUTSIDE_MODIFICATION_WINDOW");
      expect(response.body.details).toEqual({
        modificationCutoffAt: new Date(futureStart.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        policyHoursBeforeStart: 12,
      });
    });

    it("should reject cancellation for non-confirmed bookings", async () => {
      const futureStart = new Date(Date.now() + 86400000 * 3);
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "ACTIVE",
        paymentStatus: "PAID",
        startDate: futureStart,
        endDate: new Date(futureStart.getTime() + 43200000),
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${booking.id}/cancel`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Not allowed" });

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.body.errorCode).toBe("BOOKING_STATUS_NOT_MODIFIABLE");
    });

    it("should return 404 when cancelling another user's booking", async () => {
      const otherUser = await factory.createUser();
      const otherBooking = await factory.createBooking(otherUser.id, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/bookings/${otherBooking.id}/cancel`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Hijack attempt" });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe("Booking extension eligibility", () => {
    const extensionCallbackUrl = "https://example.com/extension-payment-status";

    beforeEach(() => {
      vi.mocked(flutterwaveService.createPaymentIntent).mockImplementation(async (options) => {
        const paymentIntentId = options.idempotencyKey ?? `ext-${randomUUID()}`;
        return {
          paymentIntentId,
          checkoutUrl: `https://checkout.flutterwave.com/pay/${paymentIntentId}`,
        };
      });
    });

    type LegEligibility = {
      id: string;
      canExtend: boolean;
      maxExtendableHours: number;
    };

    const utcTodayAt = (hours: number, minutes = 0): Date => {
      const now = new Date();
      return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0),
      );
    };

    const utcDaysFromToday = (dayOffset: number, hours: number, minutes = 0): Date => {
      const date = utcTodayAt(hours, minutes);
      date.setUTCDate(date.getUTCDate() + dayOffset);
      return date;
    };

    /** Future DAY window used for deterministic positive E2E assertions. */
    const FUTURE_DAY_OFFSET = 3;

    function expectNoBookingLevelExtensionFields(body: Record<string, unknown>) {
      expect(body).not.toHaveProperty("canExtend");
      expect(body).not.toHaveProperty("maxExtendableHours");
      expect(body).not.toHaveProperty("extensionBookingLegId");
    }

    function expectLegEligibility(
      body: { legs: LegEligibility[] },
      legId: string,
      expected: { canExtend: boolean; maxExtendableHours: number },
    ) {
      expect(body.legs.find((leg) => leg.id === legId)).toMatchObject(expected);
    }

    async function seedBookingWithLeg(params: {
      carId: string;
      userId?: string;
      status?: "CONFIRMED" | "ACTIVE";
      type?: "DAY" | "NIGHT";
      legStart: Date;
      legEnd: Date;
      bookingStart?: Date;
      bookingEnd?: Date;
    }) {
      const booking = await factory.createBooking(params.userId ?? testUserId, params.carId, {
        status: params.status ?? "CONFIRMED",
        paymentStatus: "PAID",
        type: params.type ?? "DAY",
        startDate: params.bookingStart ?? params.legStart,
        endDate: params.bookingEnd ?? params.legEnd,
      });
      const leg = await factory.createBookingLeg(booking.id, {
        legDate: params.legStart,
        legStartTime: params.legStart,
        legEndTime: params.legEnd,
      });
      return { booking, leg };
    }

    async function seedBlockingNightBooking(params: {
      carId: string;
      nightStart: Date;
      nightEnd: Date;
    }) {
      const otherUser = await factory.createUser();
      return seedBookingWithLeg({
        carId: params.carId,
        userId: otherUser.id,
        status: "CONFIRMED",
        type: "NIGHT",
        legStart: params.nightStart,
        legEnd: params.nightEnd,
      });
    }

    async function postExtension(
      bookingId: string,
      body: { hours: number; bookingLegId?: string },
      idempotencyKey = randomUUID(),
    ) {
      return request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/extensions`)
        .set("Cookie", testUserCookie)
        .set("Idempotency-Key", idempotencyKey)
        .send({ ...body, callbackUrl: extensionCallbackUrl });
    }

    async function seedExtendableBooking() {
      const car = await factory.createCar(fleetOwnerId);
      return seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(FUTURE_DAY_OFFSET, 8),
        legEnd: utcDaysFromToday(FUTURE_DAY_OFFSET, 20),
      });
    }

    it("requires Idempotency-Key when creating an extension", async () => {
      const { booking, leg } = await seedExtendableBooking();

      const response = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/extensions`)
        .set("Cookie", testUserCookie)
        .send({
          hours: 1,
          bookingLegId: leg.id,
          callbackUrl: extensionCallbackUrl,
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "Idempotency-Key" })]),
      );
      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("replays an identical extension request with one row and one Flutterwave call", async () => {
      const { booking, leg } = await seedExtendableBooking();
      const idempotencyKey = randomUUID();

      const first = await postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        idempotencyKey,
      );
      const replay = await postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        idempotencyKey,
      );

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(replay.status).toBe(HttpStatus.CREATED);
      expect(replay.body).toEqual(first.body);
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledOnce();
      await expect(
        databaseService.extension.count({ where: { bookingLegId: leg.id } }),
      ).resolves.toBe(1);
      await expect(
        databaseService.extension.findUniqueOrThrow({
          where: { id: first.body.extensionId },
          select: { paymentIntent: true, paymentSessionExpiresAt: true, extensionEndTime: true },
        }),
      ).resolves.toEqual({
        paymentIntent: first.body.paymentIntentId,
        paymentSessionExpiresAt: expect.any(Date),
        extensionEndTime: utcDaysFromToday(FUTURE_DAY_OFFSET, 21),
      });
      await expect(
        databaseService.booking.findUniqueOrThrow({
          where: { id: booking.id },
          select: { endDate: true },
        }),
      ).resolves.toEqual({
        endDate: utcDaysFromToday(FUTURE_DAY_OFFSET, 21),
      });
    });

    it("rejects changed extension values when the Idempotency-Key is reused", async () => {
      const { booking, leg } = await seedExtendableBooking();
      const idempotencyKey = randomUUID();

      const first = await postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        idempotencyKey,
      );
      const changed = await postExtension(
        booking.id,
        { hours: 2, bookingLegId: leg.id },
        idempotencyKey,
      );

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(changed.status).toBe(HttpStatus.CONFLICT);
      expect(changed.body.errorCode).toBe("EXTENSION_IDEMPOTENCY_KEY_REUSED");
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledOnce();
      await expect(
        databaseService.extension.count({ where: { bookingLegId: leg.id } }),
      ).resolves.toBe(1);
    });

    it("returns in progress for concurrent requests with the same key", async () => {
      const { booking, leg } = await seedExtendableBooking();
      const idempotencyKey = randomUUID();
      let signalStarted: (() => void) | undefined;
      let releasePayment: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const paymentGate = new Promise<void>((resolve) => {
        releasePayment = resolve;
      });
      vi.mocked(flutterwaveService.createPaymentIntent).mockImplementationOnce(async (options) => {
        signalStarted?.();
        await paymentGate;
        const paymentIntentId = options.idempotencyKey as string;
        return {
          paymentIntentId,
          checkoutUrl: `https://checkout.flutterwave.com/pay/${paymentIntentId}`,
        };
      });

      const firstPromise = postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        idempotencyKey,
      );
      await started;
      const concurrent = await postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        idempotencyKey,
      );
      releasePayment?.();
      const first = await firstPromise;

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(concurrent.status).toBe(HttpStatus.CONFLICT);
      expect(concurrent.body.errorCode).toBe("EXTENSION_REQUEST_IN_PROGRESS");
      expect(concurrent.headers["retry-after"]).toBe(
        String(EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS),
      );
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledOnce();
      await expect(
        databaseService.extension.count({ where: { bookingLegId: leg.id } }),
      ).resolves.toBe(1);
    });

    it("rejects a concurrent different key instead of replacing its payment reference", async () => {
      const { booking, leg } = await seedExtendableBooking();
      let signalStarted: (() => void) | undefined;
      let releasePayment: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const paymentGate = new Promise<void>((resolve) => {
        releasePayment = resolve;
      });
      vi.mocked(flutterwaveService.createPaymentIntent).mockImplementationOnce(async (options) => {
        signalStarted?.();
        await paymentGate;
        const paymentIntentId = options.idempotencyKey as string;
        return {
          paymentIntentId,
          checkoutUrl: `https://checkout.flutterwave.com/pay/${paymentIntentId}`,
        };
      });

      const firstPromise = postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        randomUUID(),
      );
      await started;
      const concurrent = await postExtension(
        booking.id,
        { hours: 1, bookingLegId: leg.id },
        randomUUID(),
      );
      releasePayment?.();
      const first = await firstPromise;

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(concurrent.status).toBe(HttpStatus.CONFLICT);
      expect(concurrent.body.errorCode).toBe("EXTENSION_PAYMENT_PENDING");
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledOnce();
      await expect(
        databaseService.extension.count({ where: { bookingLegId: leg.id } }),
      ).resolves.toBe(1);
      const extension = await databaseService.extension.findUniqueOrThrow({
        where: { id: first.body.extensionId },
      });
      expect(extension.paymentIntent).toBe(first.body.paymentIntentId);
    });

    it("marks a leg ineligible while its extension payment is pending", async () => {
      const { booking, leg } = await seedExtendableBooking();

      const created = await postExtension(booking.id, { hours: 1, bookingLegId: leg.id });
      expect(created.status).toBe(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expectLegEligibility(response.body, leg.id, {
        canExtend: false,
        maxExtendableHours: 0,
      });
    });

    it("reserves the proposed extension window before payment confirmation", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const legEnd = utcDaysFromToday(FUTURE_DAY_OFFSET, 20);
      const { booking, leg } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(FUTURE_DAY_OFFSET, 8),
        legEnd,
      });

      const created = await postExtension(booking.id, { hours: 1, bookingLegId: leg.id });
      expect(created.status).toBe(HttpStatus.CREATED);

      const otherUser = await factory.createUser();
      const otherwiseAvailableStart = new Date(legEnd.getTime() + 2.5 * 60 * 60 * 1000);
      await expect(
        factory.createBooking(otherUser.id, car.id, {
          status: "CONFIRMED",
          paymentStatus: "PAID",
          type: "NIGHT",
          startDate: otherwiseAvailableStart,
          endDate: new Date(otherwiseAvailableStart.getTime() + 60 * 60 * 1000),
        }),
      ).rejects.toThrow();
    });

    it("GET /api/bookings/:id exposes canExtend/maxExtendableHours on each leg, not the booking", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const pastStart = utcDaysFromToday(-1, 8);
      const pastEnd = utcDaysFromToday(-1, 20);
      const futureStart = utcDaysFromToday(FUTURE_DAY_OFFSET, 8);
      const futureEnd = utcDaysFromToday(FUTURE_DAY_OFFSET, 20);

      const booking = await factory.createBooking(testUserId, car.id, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        type: "DAY",
        startDate: pastStart,
        endDate: futureEnd,
      });
      const pastLeg = await factory.createBookingLeg(booking.id, {
        legDate: pastStart,
        legStartTime: pastStart,
        legEndTime: pastEnd,
      });
      const futureLeg = await factory.createBookingLeg(booking.id, {
        legDate: futureStart,
        legStartTime: futureStart,
        legEndTime: futureEnd,
      });

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expectNoBookingLevelExtensionFields(response.body);
      expectLegEligibility(response.body, pastLeg.id, { canExtend: false, maxExtendableHours: 0 });
      expectLegEligibility(response.body, futureLeg.id, {
        canExtend: true,
        maxExtendableHours: 4,
      });
    });

    it("GET /api/bookings list includes leg-level eligibility and omits booking-level fields", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const { booking, leg } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(FUTURE_DAY_OFFSET, 8),
        legEnd: utcDaysFromToday(FUTURE_DAY_OFFSET, 20),
      });

      const response = await request(app.getHttpServer())
        .get("/api/bookings")
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      const listed = (
        response.body.CONFIRMED as Array<{ id: string; legs: LegEligibility[] }>
      ).find((item) => item.id === booking.id);
      expect(listed).toBeDefined();
      if (!listed) {
        throw new Error("Expected booking in CONFIRMED list");
      }
      expectNoBookingLevelExtensionFields(listed as unknown as Record<string, unknown>);
      expectLegEligibility(listed, leg.id, { canExtend: true, maxExtendableHours: 4 });
    });

    it("preserves a free 2-hour gap (future DAY 08:00–20:00 → NIGHT 23:00–05:00 → max 1h)", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const dayOffset = FUTURE_DAY_OFFSET;
      const { booking, leg } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(dayOffset, 8),
        legEnd: utcDaysFromToday(dayOffset, 20),
      });
      // Latest extendable end = 23:00 − 2h = 21:00 → 1h.
      await seedBlockingNightBooking({
        carId: car.id,
        nightStart: utcDaysFromToday(dayOffset, 23),
        nightEnd: utcDaysFromToday(dayOffset + 1, 5),
      });

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expectNoBookingLevelExtensionFields(response.body);
      expectLegEligibility(response.body, leg.id, { canExtend: true, maxExtendableHours: 1 });
    });

    it("disallows extension when only the 2-hour gap remains (future DAY 09:00–21:00 → NIGHT 23:00 → max 0h)", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const dayOffset = FUTURE_DAY_OFFSET + 1;
      const { booking, leg } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(dayOffset, 9),
        legEnd: utcDaysFromToday(dayOffset, 21),
      });
      await seedBlockingNightBooking({
        carId: car.id,
        nightStart: utcDaysFromToday(dayOffset, 23),
        nightEnd: utcDaysFromToday(dayOffset + 1, 5),
      });

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expectNoBookingLevelExtensionFields(response.body);
      expectLegEligibility(response.body, leg.id, { canExtend: false, maxExtendableHours: 0 });
    });

    it("POST with bookingLegId rejects 2h and accepts 1h for future DAY 20:00 before NIGHT 23:00", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const dayOffset = FUTURE_DAY_OFFSET + 2;
      const { booking, leg } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(dayOffset, 8),
        legEnd: utcDaysFromToday(dayOffset, 20),
      });
      await seedBlockingNightBooking({
        carId: car.id,
        nightStart: utcDaysFromToday(dayOffset, 23),
        nightEnd: utcDaysFromToday(dayOffset + 1, 5),
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockClear();

      const rejected = await postExtension(booking.id, { hours: 2, bookingLegId: leg.id });
      expect(rejected.status).toBe(HttpStatus.BAD_REQUEST);
      expect(rejected.body.detail).toMatch(/maximum extension is 1 hour/i);
      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
      await expect(
        databaseService.extension.count({ where: { bookingLegId: leg.id } }),
      ).resolves.toBe(0);

      const accepted = await postExtension(booking.id, { hours: 1, bookingLegId: leg.id });
      expect(accepted.status).toBe(HttpStatus.CREATED);
      expect(accepted.body).toMatchObject({
        extensionId: expect.any(String),
        paymentIntentId: expect.any(String),
        checkoutUrl: expect.stringContaining("checkout.flutterwave.com"),
      });
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledTimes(1);

      const extension = await databaseService.extension.findUniqueOrThrow({
        where: { id: accepted.body.extensionId },
      });
      expect(extension.bookingLegId).toBe(leg.id);
      expect(extension.extendedDurationHours).toBe(1);
    });

    it("POST with bookingLegId creates an Extension on the requested future leg", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const todayStart = utcTodayAt(8);
      const todayEnd = utcTodayAt(20);
      const futureStart = utcDaysFromToday(FUTURE_DAY_OFFSET, 8);
      const futureEnd = utcDaysFromToday(FUTURE_DAY_OFFSET, 20);

      const booking = await factory.createBooking(testUserId, car.id, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        type: "DAY",
        startDate: todayStart,
        endDate: futureEnd,
      });
      await factory.createBookingLeg(booking.id, {
        legDate: todayStart,
        legStartTime: todayStart,
        legEndTime: todayEnd,
      });
      const futureLeg = await factory.createBookingLeg(booking.id, {
        legDate: futureStart,
        legStartTime: futureStart,
        legEndTime: futureEnd,
      });

      const response = await postExtension(booking.id, { hours: 1, bookingLegId: futureLeg.id });
      expect(response.status).toBe(HttpStatus.CREATED);

      const extension = await databaseService.extension.findUniqueOrThrow({
        where: { id: response.body.extensionId },
      });
      expect(extension.bookingLegId).toBe(futureLeg.id);
    });

    it("POST without bookingLegId does not silently target a future leg", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const { booking } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(FUTURE_DAY_OFFSET, 8),
        legEnd: utcDaysFromToday(FUTURE_DAY_OFFSET, 20),
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockClear();

      const response = await postExtension(booking.id, { hours: 1 });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.detail).toMatch(/booking leg not found/i);
      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("POST rejects foreign and past legs before creating payment", async () => {
      const car = await factory.createCar(fleetOwnerId);
      const { booking: ownBooking } = await seedBookingWithLeg({
        carId: car.id,
        legStart: utcDaysFromToday(FUTURE_DAY_OFFSET, 8),
        legEnd: utcDaysFromToday(FUTURE_DAY_OFFSET, 20),
      });
      const { leg: foreignLeg } = await seedBookingWithLeg({
        carId: car.id,
        userId: (await factory.createUser()).id,
        legStart: utcDaysFromToday(FUTURE_DAY_OFFSET + 1, 8),
        legEnd: utcDaysFromToday(FUTURE_DAY_OFFSET + 1, 20),
      });
      const { booking: pastBooking, leg: pastLeg } = await seedBookingWithLeg({
        carId: (await factory.createCar(fleetOwnerId)).id,
        legStart: utcDaysFromToday(-1, 8),
        legEnd: utcDaysFromToday(-1, 20),
      });

      vi.mocked(flutterwaveService.createPaymentIntent).mockClear();

      for (const [bookingId, bookingLegId] of [
        [ownBooking.id, foreignLeg.id],
        [pastBooking.id, pastLeg.id],
      ] as const) {
        const rejected = await postExtension(bookingId, { hours: 1, bookingLegId });
        expect(rejected.status).toBe(HttpStatus.BAD_REQUEST);
      }

      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
    });
  });
});
