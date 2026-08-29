import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      findMany: vi.fn(),
    },
    extension: {
      create: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
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

  const policyNow = new Date("2026-01-01T10:00:00.000Z");
  const todayLegDate = new Date("2026-01-01T00:00:00.000Z");
  const tomorrowLegDate = new Date("2026-01-02T00:00:00.000Z");
  const yesterdayLegDate = new Date("2025-12-31T00:00:00.000Z");
  const extensionCallback = {
    hours: 1,
    callbackUrl: "https://example.com/callback",
  } as const;
  const ineligible = { canExtend: false, maxExtendableHours: 0 } as const;

  type TestExtension = {
    id?: string;
    extensionDate?: Date;
    extensionStartTime?: Date;
    extensionEndTime: Date;
    status: string;
    paymentStatus: PaymentStatus;
  };

  function buildBooking({
    id = "booking-1",
    carId = "car-1",
    userId = "user-1",
    type = BookingType.DAY,
    status = BookingStatus.ACTIVE,
    car = { hourlyRate: 10000 },
    legId = "leg-1",
    legDate = todayLegDate,
    legEndTime = new Date("2026-01-01T13:00:00.000Z"),
    extensions = [] as TestExtension[],
    legs,
  }: {
    id?: string;
    carId?: string;
    userId?: string;
    type?: BookingType;
    status?: BookingStatus;
    car?: { hourlyRate: number };
    legId?: string;
    legDate?: Date;
    legEndTime?: Date;
    extensions?: TestExtension[];
    legs?: Array<{
      id?: string;
      legDate?: Date;
      legEndTime: Date;
      extensions?: TestExtension[];
    }>;
  } = {}) {
    return {
      id,
      carId,
      userId,
      type,
      status,
      car,
      legs: legs?.map((leg, index) => ({
        id: leg.id ?? `leg-${index + 1}`,
        legDate: leg.legDate ?? todayLegDate,
        legEndTime: leg.legEndTime,
        extensions: leg.extensions ?? [],
      })) ?? [{ id: legId, legDate, legEndTime, extensions }],
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(policyNow);
    vi.clearAllMocks();

    databaseServiceMock.$queryRaw.mockResolvedValue([{ policyNow }]);
    databaseServiceMock.booking.findMany.mockResolvedValue([]);

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

  describe("getEligibilities", () => {
    it("returns per-leg eligibility for today and future legs of a multi-day booking", async () => {
      const results = await service.getEligibilities(
        [
          buildBooking({
            status: BookingStatus.CONFIRMED,
            legs: [
              {
                id: "leg-today",
                legDate: todayLegDate,
                legEndTime: new Date("2026-01-01T13:00:00.000Z"),
              },
              {
                id: "leg-tomorrow",
                legDate: tomorrowLegDate,
                legEndTime: new Date("2026-01-02T15:00:00.000Z"),
              },
            ],
          }),
        ],
        true,
        policyNow,
      );

      expect(results.get("leg-today")).toEqual({
        canExtend: true,
        maxExtendableHours: 11,
      });
      expect(results.get("leg-tomorrow")).toEqual({
        canExtend: true,
        maxExtendableHours: 9,
      });
      expect(databaseServiceMock.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              {
                id: { not: "booking-1" },
                carId: "car-1",
                startDate: {
                  gte: new Date("2026-01-01T13:00:00.000Z"),
                  lte: new Date("2026-01-02T02:00:00.000Z"),
                },
              },
              {
                id: { not: "booking-1" },
                carId: "car-1",
                startDate: {
                  gte: new Date("2026-01-02T15:00:00.000Z"),
                  lte: new Date("2026-01-03T02:00:00.000Z"),
                },
              },
            ],
          }),
        }),
      );
    });

    it("marks past legs ineligible while still evaluating today/future legs", async () => {
      const results = await service.getEligibilities(
        [
          buildBooking({
            status: BookingStatus.CONFIRMED,
            legs: [
              {
                id: "leg-yesterday",
                legDate: yesterdayLegDate,
                legEndTime: new Date("2025-12-31T18:00:00.000Z"),
              },
              {
                id: "leg-today",
                legDate: todayLegDate,
                legEndTime: new Date("2026-01-01T13:00:00.000Z"),
              },
            ],
          }),
        ],
        true,
        policyNow,
      );

      expect(results.get("leg-yesterday")).toEqual(ineligible);
      expect(results.get("leg-today")).toEqual({
        canExtend: true,
        maxExtendableHours: 11,
      });
    });

    it("marks today's leg ineligible once its effective end has passed", async () => {
      const results = await service.getEligibilities(
        [
          buildBooking({
            status: BookingStatus.CONFIRMED,
            legId: "leg-ended-today",
            legEndTime: new Date("2026-01-01T09:00:00.000Z"),
          }),
        ],
        true,
        policyNow,
      );

      expect(results.get("leg-ended-today")).toEqual(ineligible);
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
    });

    it("clamps max hours to keep a 2-hour free buffer before the next other booking", async () => {
      databaseServiceMock.booking.findMany.mockResolvedValueOnce([
        {
          id: "other-booking",
          startDate: new Date("2026-01-01T16:00:00.000Z"),
          carId: "car-1",
        },
      ]);

      const results = await service.getEligibilities([buildBooking()], true, policyNow);

      expect(results.get("leg-1")).toEqual({
        canExtend: true,
        maxExtendableHours: 1,
      });
    });

    it("returns canExtend false when the buffer leaves no extendable hour", async () => {
      databaseServiceMock.booking.findMany.mockResolvedValueOnce([
        {
          id: "other-booking",
          startDate: new Date("2026-01-01T16:00:00.000Z"),
          carId: "car-1",
        },
      ]);

      const results = await service.getEligibilities(
        [buildBooking({ legEndTime: new Date("2026-01-01T14:00:00.000Z") })],
        true,
        policyNow,
      );

      expect(results.get("leg-1")).toEqual(ineligible);
    });

    it("uses the midnight cap when there is no next booking", async () => {
      const results = await service.getEligibilities(
        [
          buildBooking({
            status: BookingStatus.CONFIRMED,
            legEndTime: new Date("2026-01-01T20:00:00.000Z"),
          }),
        ],
        true,
        policyNow,
      );

      expect(results.get("leg-1")).toEqual({
        canExtend: true,
        maxExtendableHours: 4,
      });
      expect(databaseServiceMock.booking.findMany).toHaveBeenCalledOnce();
    });

    it("uses a paid ACTIVE extension end as the current end", async () => {
      databaseServiceMock.booking.findMany.mockResolvedValueOnce([
        {
          id: "other-booking",
          startDate: new Date("2026-01-01T18:00:00.000Z"),
          carId: "car-1",
        },
      ]);

      const results = await service.getEligibilities(
        [
          buildBooking({
            legEndTime: new Date("2026-01-01T12:00:00.000Z"),
            extensions: [
              {
                extensionEndTime: new Date("2026-01-01T14:00:00.000Z"),
                status: "ACTIVE",
                paymentStatus: PaymentStatus.PAID,
              },
            ],
          }),
        ],
        true,
        policyNow,
      );

      // Current end 14:00, next at 18:00 → buffer limit 16:00 → 2 hours
      expect(results.get("leg-1")).toEqual({
        canExtend: true,
        maxExtendableHours: 2,
      });
    });

    it("marks non-DAY booking legs ineligible without querying next bookings", async () => {
      const results = await service.getEligibilities(
        [buildBooking({ type: BookingType.NIGHT })],
        true,
        policyNow,
      );

      expect(results.get("leg-1")).toEqual(ineligible);
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
    });

    it("marks non-confirmed/active booking legs ineligible without querying next bookings", async () => {
      const results = await service.getEligibilities(
        [buildBooking({ status: BookingStatus.COMPLETED })],
        true,
        policyNow,
      );

      expect(results.get("leg-1")).toEqual(ineligible);
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
    });

    it("returns ineligible defaults for every leg when canAct is false without querying next bookings", async () => {
      const results = await service.getEligibilities(
        [
          buildBooking({
            legs: [
              {
                id: "leg-today",
                legDate: todayLegDate,
                legEndTime: new Date("2026-01-01T13:00:00.000Z"),
              },
              {
                id: "leg-tomorrow",
                legDate: tomorrowLegDate,
                legEndTime: new Date("2026-01-02T15:00:00.000Z"),
              },
            ],
          }),
        ],
        false,
        policyNow,
      );

      expect(results.get("leg-today")).toEqual(ineligible);
      expect(results.get("leg-tomorrow")).toEqual(ineligible);
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
    });
  });

  describe("createExtension", () => {
    it("creates extension payment intent for active hourly booking", async () => {
      const legEndTime = new Date(policyNow.getTime() + 60 * 60 * 1000);

      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({ legDate: policyNow, legEndTime }),
      );
      databaseServiceMock.extension.create.mockResolvedValueOnce({
        id: "ext-1",
      });

      const result = await service.createExtension(
        "booking-1",
        { hours: 2, callbackUrl: extensionCallback.callbackUrl },
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

    it("uses today's leg when bookingLegId is omitted for a multi-day booking", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          legs: [
            {
              id: "leg-tomorrow",
              legDate: tomorrowLegDate,
              legEndTime: new Date("2026-01-02T15:00:00.000Z"),
            },
            {
              id: "leg-today",
              legDate: todayLegDate,
              legEndTime: new Date("2026-01-01T13:00:00.000Z"),
            },
          ],
        }),
      );
      databaseServiceMock.extension.create.mockResolvedValueOnce({ id: "ext-1" });

      await service.createExtension("booking-1", extensionCallback, authUser);

      expect(databaseServiceMock.extension.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingLegId: "leg-today",
            extendedDurationHours: 1,
          }),
        }),
      );
    });

    it("targets an explicit future bookingLegId when provided", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          legs: [
            {
              id: "leg-today",
              legDate: todayLegDate,
              legEndTime: new Date("2026-01-01T13:00:00.000Z"),
            },
            {
              id: "leg-tomorrow",
              legDate: tomorrowLegDate,
              legEndTime: new Date("2026-01-02T15:00:00.000Z"),
            },
          ],
        }),
      );
      databaseServiceMock.extension.create.mockResolvedValueOnce({ id: "ext-future" });

      await service.createExtension(
        "booking-1",
        {
          hours: 2,
          callbackUrl: extensionCallback.callbackUrl,
          bookingLegId: "leg-tomorrow",
        },
        authUser,
      );

      expect(databaseServiceMock.extension.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingLegId: "leg-tomorrow",
            extendedDurationHours: 2,
            extensionStartTime: new Date("2026-01-02T15:00:00.000Z"),
          }),
        }),
      );
    });

    it("rejects a bookingLegId that does not belong to the booking", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());

      await expect(
        service.createExtension(
          "booking-1",
          {
            hours: 1,
            callbackUrl: extensionCallback.callbackUrl,
            bookingLegId: "foreign-leg",
          },
          authUser,
        ),
      ).rejects.toThrow("Booking leg not found");

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
    });

    it("rejects a past or ended bookingLegId before creating a payment intent", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          legs: [
            {
              id: "leg-ended-today",
              legDate: todayLegDate,
              legEndTime: new Date("2026-01-01T09:00:00.000Z"),
            },
          ],
        }),
      );

      await expect(
        service.createExtension(
          "booking-1",
          {
            hours: 1,
            callbackUrl: extensionCallback.callbackUrl,
            bookingLegId: "leg-ended-today",
          },
          authUser,
        ),
      ).rejects.toThrow("Booking leg cannot be extended");

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
    });

    it("rejects hours above the buffer-clamped maximum before creating a payment intent", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      databaseServiceMock.booking.findMany.mockResolvedValueOnce([
        {
          id: "other-booking",
          startDate: new Date("2026-01-01T16:00:00.000Z"),
          carId: "car-1",
        },
      ]);

      await expect(
        service.createExtension(
          "booking-1",
          { hours: 2, callbackUrl: extensionCallback.callbackUrl },
          authUser,
        ),
      ).rejects.toThrow("Maximum extension is 1 hour(s) for this leg");

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
    });

    it("throws when active booking is not found", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createExtension("missing-booking", extensionCallback, authUser),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws when booking type is not DAY", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          type: BookingType.NIGHT,
          legDate: policyNow,
          legEndTime: new Date(policyNow.getTime() + 60 * 60 * 1000),
        }),
      );

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser),
      ).rejects.toThrow("Only DAY bookings can be extended");
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
    });

    it("updates existing pending unpaid extension when start time matches", async () => {
      const legEndTime = new Date(policyNow.getTime() + 2 * 60 * 60 * 1000);
      const pendingExtensionEnd = new Date(legEndTime.getTime() + 1 * 60 * 60 * 1000);

      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          legDate: policyNow,
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
        }),
      );
      databaseServiceMock.extension.update.mockResolvedValueOnce({ id: "ext-pending-1" });

      await service.createExtension(
        "booking-1",
        { hours: 2, callbackUrl: extensionCallback.callbackUrl },
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

    it("throws when requested extension exceeds the leg max hours", async () => {
      const twoHoursToMidnight = new Date("2026-01-01T22:00:00.000Z");

      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          legEndTime: twoHoursToMidnight,
          extensions: [
            {
              extensionDate: policyNow,
              extensionEndTime: twoHoursToMidnight,
              status: "ACTIVE",
              paymentStatus: PaymentStatus.PAID,
            },
          ],
        }),
      );

      await expect(
        service.createExtension(
          "booking-1",
          { hours: 3, callbackUrl: extensionCallback.callbackUrl },
          authUser,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
    });
  });
});
