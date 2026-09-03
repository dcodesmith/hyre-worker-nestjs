import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

const TOTAL = 112875;
const INTERNAL_FIELDS = [
  "guestAccessTokenHash",
  "guestAccessTokenExpiresAt",
  "fleetOwnerPayoutAmountNet",
  "platformFleetOwnerCommissionAmount",
  "webhookPayload",
  "verificationResponse",
];

describe("Booking receipt E2E", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let carId: string;
  let customerId: string;
  let customerCookie: string;
  let otherCustomerCookie: string;
  let fleetOwnerCookie: string;
  let adminCookie: string;
  let staffCookie: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    const customer = await factory.authenticateAndGetUser(uniqueEmail("receipt-customer"), "user");
    customerId = customer.user.id;
    customerCookie = customer.cookie;
    otherCustomerCookie = await factory.authenticateAndGetCookie(
      uniqueEmail("receipt-other"),
      "user",
    );
    const fleetOwner = await factory.authenticateAndGetUser(
      uniqueEmail("receipt-owner"),
      "fleetOwner",
      "web",
    );
    fleetOwnerCookie = fleetOwner.cookie;
    carId = (await factory.createCar(fleetOwner.user.id)).id;
    adminCookie = (await factory.createAuthenticatedAdmin(uniqueEmail("receipt-admin"))).cookie;
    const staff = await factory.authenticateAndGetUser(uniqueEmail("receipt-staff"), "user");
    await factory.assignRole(staff.user.id, "staff");
    staffCookie = staff.cookie;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createReceiptBooking(
    userId: string | null,
    options: {
      status?: BookingStatus;
      paymentStatus?: PaymentStatus;
      guestToken?: string;
      guestTokenExpiresAt?: Date;
    } = {},
  ) {
    const paymentStatus = options.paymentStatus ?? PaymentStatus.PAID;
    const isRefunded =
      paymentStatus === PaymentStatus.PARTIALLY_REFUNDED ||
      paymentStatus === PaymentStatus.REFUNDED;
    const refundAmount =
      paymentStatus === PaymentStatus.REFUNDED
        ? TOTAL
        : paymentStatus === PaymentStatus.PARTIALLY_REFUNDED
          ? 20000
          : 0;
    const booking = await databaseService.booking.create({
      data: {
        userId,
        guestUser: userId ? undefined : { name: "Guest Customer", email: "guest@example.com" },
        carId,
        bookingReference: `TRIP-${randomUUID()}`,
        status: options.status ?? BookingStatus.COMPLETED,
        paymentStatus,
        startDate: new Date("2026-08-20T08:00:00.000Z"),
        endDate: new Date("2026-08-20T20:00:00.000Z"),
        pickupLocation: "Lagos Airport",
        returnLocation: "Victoria Island",
        totalAmount: TOTAL,
        netTotal: 100000,
        platformCustomerServiceFeeAmount: 5000,
        subtotalBeforeVat: 105000,
        vatAmount: 7875,
        vatRatePercent: 7.5,
        referralDiscountAmount: 0,
        referralCreditsUsed: 0,
        ...(options.guestToken && {
          guestAccessTokenHash: createHash("sha256").update(options.guestToken).digest("hex"),
          guestAccessTokenExpiresAt:
            options.guestTokenExpiresAt ?? new Date(Date.now() + 10 * 60_000),
        }),
      },
    });

    if (paymentStatus === PaymentStatus.UNPAID) return booking;

    const payment = await databaseService.payment.create({
      data: {
        bookingId: booking.id,
        txRef: `booking_${booking.id}`,
        amountExpected: TOTAL,
        amountCharged: TOTAL,
        currency: "NGN",
        status: isRefunded
          ? paymentStatus === PaymentStatus.REFUNDED
            ? PaymentAttemptStatus.REFUNDED
            : PaymentAttemptStatus.PARTIALLY_REFUNDED
          : PaymentAttemptStatus.SUCCESSFUL,
        confirmedAt: new Date("2026-08-01T12:00:00.000Z"),
        webhookPayload: isRefunded ? { refundAmount } : undefined,
      },
    });
    return databaseService.booking.update({
      where: { id: booking.id },
      data: { paymentId: payment.id },
    });
  }

  function expectSafeProblem(body: unknown): void {
    const response = JSON.stringify(body);
    for (const field of INTERNAL_FIELDS) expect(response).not.toContain(field);
  }

  it("streams a signed-in customer's PDF with safe attachment headers", async () => {
    const booking = await createReceiptBooking(customerId);

    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/receipt`)
      .set("Cookie", customerCookie)
      .buffer(true);

    expect(response.status).toBe(HttpStatus.OK);
    expect(Buffer.from(response.body).subarray(0, 4).toString()).toBe("%PDF");
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="Tripdly-receipt-${booking.bookingReference}.pdf"`,
    );
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Number(response.headers["content-length"])).toBe(Buffer.from(response.body).length);
  });

  it("returns enumeration-safe 404 to another customer", async () => {
    const booking = await createReceiptBooking(customerId);
    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/receipt`)
      .set("Cookie", otherCustomerCookie);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.errorCode).toBe("BOOKING_NOT_FOUND");
    expectSafeProblem(response.body);
  });

  it.each([
    ["fleet owner", () => fleetOwnerCookie],
    ["admin", () => adminCookie],
    ["staff", () => staffCookie],
  ])("does not grant %s access to a customer's receipt", async (_role, getCookie) => {
    const booking = await createReceiptBooking(customerId);
    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/receipt`)
      .set("Cookie", getCookie());

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.errorCode).toBe("BOOKING_NOT_FOUND");
    expectSafeProblem(response.body);
  });

  it("accepts a valid opaque guest token in X-Guest-Booking-Token", async () => {
    const token = randomBytes(32).toString("base64url");
    const booking = await createReceiptBooking(null, { guestToken: token });

    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/receipt`)
      .set("X-Guest-Booking-Token", token)
      .set("Cookie", "session_token=expired")
      .buffer(true);

    expect(response.status).toBe(HttpStatus.OK);
    expect(Buffer.from(response.body).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("returns 401 when neither a session nor guest token is supplied", async () => {
    const booking = await createReceiptBooking(null);
    const response = await request(app.getHttpServer()).get(`/api/bookings/${booking.id}/receipt`);

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expectSafeProblem(response.body);
  });

  it.each([
    ["invalid", "invalid", undefined],
    ["expired", randomBytes(32).toString("base64url"), new Date(Date.now() - 1_000)],
  ])("rejects an %s guest token as enumeration-safe 404", async (_case, token, expiresAt) => {
    const booking = await createReceiptBooking(null, {
      guestToken: token.length === 43 ? token : randomBytes(32).toString("base64url"),
      guestTokenExpiresAt: expiresAt,
    });
    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/receipt`)
      .set("X-Guest-Booking-Token", token);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.errorCode).toBe("BOOKING_NOT_FOUND");
    expectSafeProblem(response.body);
  });

  it("rejects a guest token scoped to another booking", async () => {
    const token = randomBytes(32).toString("base64url");
    await createReceiptBooking(null, { guestToken: token });
    const otherBooking = await createReceiptBooking(null, {
      guestToken: randomBytes(32).toString("base64url"),
    });

    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${otherBooking.id}/receipt`)
      .set("X-Guest-Booking-Token", token);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.errorCode).toBe("BOOKING_NOT_FOUND");
    expectSafeProblem(response.body);
  });

  it("returns typed Problem Details for an accessible ineligible booking", async () => {
    const booking = await createReceiptBooking(customerId, {
      status: BookingStatus.COMPLETED,
      paymentStatus: PaymentStatus.UNPAID,
    });
    const response = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/receipt`)
      .set("Cookie", customerCookie);

    expect(response.status).toBe(HttpStatus.CONFLICT);
    expect(response.body).toMatchObject({
      type: "BOOKING_RECEIPT_NOT_AVAILABLE",
      errorCode: "BOOKING_RECEIPT_NOT_AVAILABLE",
      status: HttpStatus.CONFLICT,
    });
    expectSafeProblem(response.body);
  });
});
