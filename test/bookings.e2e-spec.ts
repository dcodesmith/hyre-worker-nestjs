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
import { MapsService } from "../src/modules/maps/maps.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Bookings E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let mapsService: MapsService;
  let factory: TestDataFactory;

  let testUserCookie: string;
  let testUserId: string;
  let testCarId: string;

  beforeAll(async () => {
    const mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);

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
    const car = await factory.createCar(fleetOwner.id);
    testCarId = car.id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    vi.restoreAllMocks();

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
    const createValidBookingPayload = (carId: string) => ({
      carId,
      startDate: new Date(Date.now() + 86400000 * 2).toISOString(), // 2 days from now
      endDate: new Date(Date.now() + 86400000 * 2 + 43200000).toISOString(), // 2 days + 12 hours
      pickupAddress: "123 Main St, Lagos",
      bookingType: "DAY",
      pickupTime: "9:00 AM",
      sameLocation: true,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      // Note: clientTotalAmount is optional - omitting it skips price validation
    });

    const createGuestBookingPayload = (carId: string) => ({
      ...createValidBookingPayload(carId),
      guestEmail: "guest@example.com",
      guestName: "Guest User",
      guestPhone: "08012345678",
    });

    describe("Authenticated User Bookings", () => {
      it("should create a booking for authenticated user", async () => {
        const payload = createValidBookingPayload(testCarId);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body).toHaveProperty("bookingId");
        expect(response.body).toHaveProperty("checkoutUrl");
        expect(response.body.checkoutUrl).toContain("checkout.flutterwave.com");
      });

      it("should return 404 for non-existent car", async () => {
        const payload = createValidBookingPayload("non-existent-car-id");

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.NOT_FOUND);
      });
    });

    describe("Guest Bookings", () => {
      it("should create a booking for guest user", async () => {
        const payload = createGuestBookingPayload(testCarId);

        const response = await request(app.getHttpServer()).post("/api/bookings").send(payload);

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

        const payload = createValidBookingPayload(testCarId);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.checkoutUrl).toBe(mockCheckoutUrl);
      });

      it("should handle payment intent creation failure gracefully", async () => {
        vi.spyOn(flutterwaveService, "createPaymentIntent").mockRejectedValueOnce(
          new Error("Payment provider unavailable"),
        );

        const payload = createValidBookingPayload(testCarId);

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBeGreaterThanOrEqual(HttpStatus.BAD_REQUEST);
      });
    });
  });

  describe("GET /api/bookings", () => {
    it("should return 401 without authentication", async () => {
      const response = await request(app.getHttpServer()).get("/api/bookings");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should return bookings grouped by status for authenticated user", async () => {
      await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .get("/api/bookings")
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toBeTypeOf("object");
      expect(response.body.CONFIRMED).toBeInstanceOf(Array);
      expect(response.body.CONFIRMED.length).toBeGreaterThanOrEqual(1);
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
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.id).toBe(booking.id);
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

  describe("DELETE /api/bookings/:bookingId", () => {
    it("should return 401 without authentication", async () => {
      const response = await request(app.getHttpServer())
        .delete("/api/bookings/some-id")
        .send({ reason: "test" });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should cancel a confirmed booking", async () => {
      const booking = await factory.createBooking(testUserId, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .delete(`/api/bookings/${booking.id}`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Plans changed" });

      expect(response.status).toBe(HttpStatus.OK);

      const cancelled = await factory.getBookingById(booking.id);
      expect(cancelled?.status).toBe("CANCELLED");
    });

    it("should return 404 when cancelling another user's booking", async () => {
      const otherUser = await factory.createUser();
      const otherBooking = await factory.createBooking(otherUser.id, testCarId, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
      });

      const response = await request(app.getHttpServer())
        .delete(`/api/bookings/${otherBooking.id}`)
        .set("Cookie", testUserCookie)
        .send({ reason: "Hijack attempt" });

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });
});
