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

  // Test data
  let testUserCookie: string;
  let testCarId: string;

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
    mapsService = app.get(MapsService);
    factory = new TestDataFactory(databaseService, app);

    await app.init();

    // Create platform rates required for booking calculations
    await factory.createPlatformRates();

    // Create test user
    const testEmail = uniqueEmail("booking-test-user");
    const testResult = await factory.authenticateAndGetUser(testEmail, "user");
    testUserCookie = testResult.cookie;

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

      it("should return 400 for invalid booking type", async () => {
        const payload = {
          ...createValidBookingPayload(testCarId),
          bookingType: "INVALID_TYPE",
        };

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(response.body.message).toContain("Validation");
      });

      it("should return 400 for missing required fields", async () => {
        const payload = {
          carId: testCarId,
          // Missing required fields
        };

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(response.body.message).toContain("Validation");
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

      it("should return 400 when guest fields are missing without authentication", async () => {
        const payload = createValidBookingPayload(testCarId);
        // Not authenticated and no guest fields

        const response = await request(app.getHttpServer()).post("/api/bookings").send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it("should return 400 for invalid guest email", async () => {
        const payload = {
          ...createGuestBookingPayload(testCarId),
          guestEmail: "not-an-email",
        };

        const response = await request(app.getHttpServer()).post("/api/bookings").send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(response.body.message).toContain("Validation");
      });

      it("should return 400 for invalid guest phone", async () => {
        const payload = {
          ...createGuestBookingPayload(testCarId),
          guestPhone: "123", // Too short
        };

        const response = await request(app.getHttpServer()).post("/api/bookings").send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(response.body.message).toContain("Validation");
      });
    });

    describe("Validation", () => {
      it("should reject booking with end date before start date", async () => {
        const now = Date.now();
        const payload = {
          ...createValidBookingPayload(testCarId),
          startDate: new Date(now + 86400000 * 3).toISOString(),
          endDate: new Date(now + 86400000 * 2).toISOString(), // Before start
        };

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it("should reject booking with dates in the past", async () => {
        const payload = {
          ...createValidBookingPayload(testCarId),
          startDate: new Date(Date.now() - 86400000).toISOString(), // Yesterday
          endDate: new Date().toISOString(),
        };

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it("should require hoursBooked for HOURLY booking type", async () => {
        const payload = {
          ...createValidBookingPayload(testCarId),
          bookingType: "HOURLY",
          // Missing hoursBooked
        };

        const response = await request(app.getHttpServer())
          .post("/api/bookings")
          .set("Cookie", testUserCookie)
          .send(payload);

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
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

        // Should return appropriate error status
        expect(response.status).toBeGreaterThanOrEqual(HttpStatus.BAD_REQUEST);
      });
    });
  });
});
