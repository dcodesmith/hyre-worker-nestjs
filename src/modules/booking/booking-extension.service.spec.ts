import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RatesService } from "../rates/rates.service";
import { BookingExtensionService } from "./booking-extension.service";

describe("BookingExtensionService", () => {
  let service: BookingExtensionService;

  const databaseServiceMock = {
    booking: {
      findFirst: vi.fn(),
    },
    extension: {
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const ratesServiceMock = {
    getRates: vi.fn().mockResolvedValue({
      vatRatePercent: 7.5,
      platformCustomerServiceFeeRatePercent: 5,
      platformFleetOwnerCommissionRatePercent: 10,
    }),
  };

  const flutterwaveServiceMock = {
    createPaymentIntent: vi.fn().mockResolvedValue({
      paymentIntentId: "tx-ext-001",
      checkoutUrl: "https://checkout.flutterwave.com/pay/ext-001",
    }),
  };

  const authUser = {
    id: "user-1",
    email: "user@example.com",
    name: "Test User",
    emailVerified: true,
    image: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    roles: ["user" as const],
  } satisfies AuthSession["user"];

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingExtensionService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: RatesService, useValue: ratesServiceMock },
        { provide: FlutterwaveService, useValue: flutterwaveServiceMock },
      ],
    }).compile();

    service = module.get<BookingExtensionService>(BookingExtensionService);
  });

  it("creates extension payment intent for active hourly booking", async () => {
    const now = new Date();
    const legEndTime = new Date(now.getTime() + 60 * 60 * 1000);

    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.ACTIVE,
      type: BookingType.DAY,
      car: { hourlyRate: 10000 },
      legs: [
        {
          id: "leg-1",
          legDate: now,
          legEndTime,
          extensions: [],
        },
      ],
    });
    databaseServiceMock.extension.create.mockResolvedValueOnce({
      id: "ext-1",
    });

    const result = await service.createExtension(
      "booking-1",
      { hours: 2, callbackUrl: "https://example.com/callback" },
      authUser,
    );

    expect(result).toEqual({
      extensionId: "ext-1",
      paymentIntentId: "tx-ext-001",
      checkoutUrl: "https://checkout.flutterwave.com/pay/ext-001",
    });
    expect(flutterwaveServiceMock.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionType: "booking_extension",
        callbackUrl: "https://example.com/callback",
      }),
    );
    expect(databaseServiceMock.extension.create).toHaveBeenCalled();
  });

  it("throws when active booking is not found", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.createExtension(
        "missing-booking",
        { hours: 1, callbackUrl: "https://example.com/callback" },
        authUser,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws when booking type is not DAY", async () => {
    const now = new Date();
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.ACTIVE,
      type: BookingType.NIGHT,
      car: { hourlyRate: 10000 },
      legs: [
        {
          id: "leg-1",
          legDate: now,
          legEndTime: new Date(now.getTime() + 60 * 60 * 1000),
          extensions: [],
        },
      ],
    });

    await expect(
      service.createExtension(
        "booking-1",
        { hours: 1, callbackUrl: "https://example.com/callback" },
        authUser,
      ),
    ).rejects.toThrow("Only DAY bookings can be extended");
  });

  it("updates existing pending unpaid extension when start time matches", async () => {
    const now = new Date();
    const legEndTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const pendingExtensionEnd = new Date(legEndTime.getTime() + 1 * 60 * 60 * 1000);

    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.ACTIVE,
      type: BookingType.DAY,
      car: { hourlyRate: 10000 },
      legs: [
        {
          id: "leg-1",
          legDate: now,
          legEndTime,
          extensions: [
            {
              id: "ext-pending-1",
              extensionStartTime: legEndTime,
              extensionEndTime: pendingExtensionEnd,
              status: "PENDING",
              paymentStatus: PaymentStatus.UNPAID,
            },
          ],
        },
      ],
    });
    databaseServiceMock.extension.update.mockResolvedValueOnce({ id: "ext-pending-1" });

    await service.createExtension(
      "booking-1",
      { hours: 2, callbackUrl: "https://example.com/callback" },
      authUser,
    );

    expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
    expect(databaseServiceMock.extension.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ext-pending-1" },
      }),
    );
    const updateCall = databaseServiceMock.extension.update.mock.calls[0][0];
    const startTime = new Date(updateCall.data.extensionStartTime);
    expect(startTime.getTime()).toBe(legEndTime.getTime());
  });

  it("throws when requested extension exceeds today's max hours", async () => {
    const now = new Date();
    const twoHoursToMidnight = new Date(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() -
        2 * 60 * 60 * 1000,
    );

    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.ACTIVE,
      type: BookingType.DAY,
      car: { hourlyRate: 10000 },
      legs: [
        {
          id: "leg-1",
          legDate: now,
          legEndTime: twoHoursToMidnight,
          extensions: [
            {
              extensionDate: now,
              extensionEndTime: twoHoursToMidnight,
              status: "ACTIVE",
              paymentStatus: PaymentStatus.PAID,
            },
          ],
        },
      ],
    });

    await expect(
      service.createExtension(
        "booking-1",
        { hours: 3, callbackUrl: "https://example.com/callback" },
        authUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
