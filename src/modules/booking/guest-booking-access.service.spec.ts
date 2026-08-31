import { createHash } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPinoLogger } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { BookingNotFoundException } from "./booking.error";
import { GuestBookingAccessService } from "./guest-booking-access.service";

describe("GuestBookingAccessService", () => {
  let service: GuestBookingAccessService;
  const databaseService = {
    booking: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const emailService = { sendEmail: vi.fn() };
  const logger = createMockPinoLogger();

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.WEBSITE_URL = "https://app.example.com";
    databaseService.booking.updateMany.mockResolvedValue({ count: 1 });
    emailService.sendEmail.mockResolvedValue({ id: "email-1" });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestBookingAccessService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: EmailService, useValue: emailService },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();
    service = module.get(GuestBookingAccessService);
  });

  it("returns the same accepted response without revealing whether a booking matched", async () => {
    databaseService.booking.findUnique.mockResolvedValue(null);

    await expect(
      service.requestAccess({
        bookingReference: "BK-MISSING",
        email: "guest@example.com",
      }),
    ).resolves.toEqual({
      message: "If those booking details match, we sent an access link to the booking email.",
    });
    expect(databaseService.booking.updateMany).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("emails a short-lived opaque link for a matching guest booking", async () => {
    databaseService.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      bookingReference: "BK-1",
      userId: null,
      guestUser: { email: "Guest@Example.com", name: "Guest User" },
    });

    await service.requestAccess({ bookingReference: "BK-1", email: "guest@example.com" });

    await vi.waitFor(() => expect(emailService.sendEmail).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });
    expect(logger.error).not.toHaveBeenCalled();
    const email = emailService.sendEmail.mock.calls[0][0];
    const token = String(email.html).match(/token=([A-Za-z0-9_-]{43})/)?.[1] ?? "";
    expect(token).toHaveLength(43);
    expect(email).toMatchObject({
      to: "Guest@Example.com",
      subject: "View booking BK-1",
    });
    expect(databaseService.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        userId: null,
        deletedAt: null,
        OR: [
          { guestAccessTokenHash: null },
          { guestAccessTokenExpiresAt: null },
          { guestAccessTokenExpiresAt: { lte: expect.any(Date) } },
        ],
      },
      data: {
        guestAccessTokenHash: createHash("sha256").update(token).digest("hex"),
        guestAccessTokenExpiresAt: expect.any(Date),
      },
    });
  });

  it("does not email WhatsApp-only guest bookings", async () => {
    databaseService.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      bookingReference: "BK-1",
      userId: null,
      guestUser: {
        email: "whatsapp.2348012345678@tripdly.com",
        guestContactSource: "WHATSAPP_AGENT",
        preferredNotificationChannel: "WHATSAPP_ONLY",
      },
    });

    await service.requestAccess({
      bookingReference: "BK-1",
      email: "whatsapp.2348012345678@tripdly.com",
    });

    expect(databaseService.booking.updateMany).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("coalesces concurrent access requests while the first link is active", async () => {
    databaseService.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      bookingReference: "BK-1",
      userId: null,
      guestUser: { email: "guest@example.com", name: "Guest User" },
    });
    databaseService.booking.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await Promise.all([
      service.requestAccess({ bookingReference: "BK-1", email: "guest@example.com" }),
      service.requestAccess({ bookingReference: "BK-1", email: "guest@example.com" }),
    ]);

    await vi.waitFor(() => expect(emailService.sendEmail).toHaveBeenCalledOnce());
  });

  it("releases the access-link claim when email delivery fails", async () => {
    databaseService.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      bookingReference: "BK-1",
      userId: null,
      guestUser: { email: "guest@example.com", name: "Guest User" },
    });
    emailService.sendEmail.mockRejectedValueOnce(new Error("email unavailable"));

    await service.requestAccess({ bookingReference: "BK-1", email: "guest@example.com" });

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(databaseService.booking.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "booking-1",
        guestAccessTokenHash: expect.any(String),
      },
      data: {
        guestAccessTokenHash: null,
        guestAccessTokenExpiresAt: null,
      },
    });
  });

  it("returns only the explicit guest booking contract for a valid token", async () => {
    const expiresAt = new Date("2099-01-01T00:15:00.000Z");
    databaseService.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      bookingReference: "BK-1",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      type: "DAY",
      startDate: new Date("2099-01-02T08:00:00.000Z"),
      endDate: new Date("2099-01-02T20:00:00.000Z"),
      pickupLocation: "Lagos",
      returnLocation: "Lekki",
      specialRequests: null,
      cancellationReason: null,
      flightNumber: null,
      totalAmount: { toNumber: () => 50_000 },
      guestAccessTokenExpiresAt: expiresAt,
      car: {
        make: "Toyota",
        model: "Camry",
        year: 2025,
        images: [{ url: "https://cdn.example.com/car.jpg" }],
      },
      chauffeur: { name: "Driver", phoneNumber: "08000000000" },
      legs: [
        {
          id: "leg-1",
          legDate: new Date("2099-01-02T00:00:00.000Z"),
          legStartTime: new Date("2099-01-02T08:00:00.000Z"),
          legEndTime: new Date("2099-01-02T20:00:00.000Z"),
          extensions: [],
        },
      ],
    });

    const result = await service.getBooking({ token: "a".repeat(43) });

    expect(result).toMatchObject({
      bookingId: "booking-1",
      bookingReference: "BK-1",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      currency: "NGN",
      totalAmount: 50_000,
      accessExpiresAt: expiresAt.toISOString(),
      car: { images: ["https://cdn.example.com/car.jpg"] },
      chauffeur: { name: "Driver", phoneNumber: "08000000000" },
      legs: [{ id: "leg-1", extensions: [] }],
    });
    expect(result).not.toHaveProperty("guestUser");
    expect(result).not.toHaveProperty("user");
    expect(result).not.toHaveProperty("paymentIntent");
  });

  it("rejects an invalid or expired guest access token without revealing details", async () => {
    databaseService.booking.findFirst.mockResolvedValue(null);

    await expect(service.getBooking({ token: "a".repeat(43) })).rejects.toBeInstanceOf(
      BookingNotFoundException,
    );
  });

  it("validates a guest token against the requested booking and current expiry", async () => {
    databaseService.booking.findFirst.mockResolvedValueOnce({ id: "booking-1" });
    const token = "a".repeat(43);

    await expect(service.assertBookingAccess("booking-1", token)).resolves.toBeUndefined();

    expect(databaseService.booking.findFirst).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        guestAccessTokenHash: createHash("sha256").update(token).digest("hex"),
        guestAccessTokenExpiresAt: { gt: expect.any(Date) },
        userId: null,
        deletedAt: null,
      },
      select: { id: true },
    });
  });

  it("rejects malformed, expired or differently scoped guest receipt tokens as not found", async () => {
    await expect(service.assertBookingAccess("booking-1", "invalid")).rejects.toBeInstanceOf(
      BookingNotFoundException,
    );
    expect(databaseService.booking.findFirst).not.toHaveBeenCalled();

    databaseService.booking.findFirst.mockResolvedValueOnce(null);
    await expect(service.assertBookingAccess("booking-1", "a".repeat(43))).rejects.toBeInstanceOf(
      BookingNotFoundException,
    );
  });
});
