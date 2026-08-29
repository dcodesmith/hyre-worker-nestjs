import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, BookingType, PaymentStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RatesService } from "../rates/rates.service";
import {
  ExtensionAlreadyConfirmedException,
  ExtensionPaymentPendingException,
  ExtensionPaymentSessionExpiredException,
  ExtensionStateChangedException,
} from "./booking.error";
import { BookingExtensionService } from "./booking-extension.service";
import { BookingReservationService } from "./booking-reservation.service";
import { ExtensionCreationIdempotencyService } from "./extension-creation-idempotency.service";

describe("BookingExtensionService", () => {
  let service: BookingExtensionService;

  const databaseServiceMock = {
    booking: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    extension: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    bookingLeg: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
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
      paymentIntentId: "ext-idem-1",
      checkoutUrl: "https://checkout.flutterwave.com/pay/ext-001",
    }),
  };

  const idempotencyServiceMock = {
    getCustomerScope: vi.fn().mockReturnValue("user:user-1"),
    findResolvedBookingLegId: vi.fn().mockResolvedValue(null),
    createRequestHash: vi.fn().mockReturnValue("request-hash"),
    claim: vi.fn().mockResolvedValue({ kind: "claimed", id: "idem-1" }),
    createPaymentIntentReference: vi.fn().mockReturnValue("ext-idem-1"),
    attachExtension: vi.fn().mockResolvedValue(undefined),
    checkpointResponse: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const bookingReservationServiceMock = {
    isOverlapConstraintViolation: vi.fn().mockReturnValue(false),
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
    databaseServiceMock.booking.findUnique.mockResolvedValue(buildBooking());
    databaseServiceMock.booking.updateMany.mockResolvedValue({ count: 1 });
    databaseServiceMock.extension.findFirst.mockResolvedValue(null);
    databaseServiceMock.bookingLeg.findUnique.mockResolvedValue({
      legEndTime: new Date("2026-01-01T13:00:00.000Z"),
      extensions: [],
    });
    databaseServiceMock.$transaction.mockImplementation(async (callback) =>
      callback(databaseServiceMock),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingExtensionService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: RatesService, useValue: ratesServiceMock },
        { provide: FlutterwaveService, useValue: flutterwaveServiceMock },
        { provide: ExtensionCreationIdempotencyService, useValue: idempotencyServiceMock },
        { provide: BookingReservationService, useValue: bookingReservationServiceMock },
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

    it("marks a leg with a pending unpaid extension ineligible", async () => {
      const results = await service.getEligibilities(
        [
          buildBooking({
            extensions: [
              {
                extensionEndTime: new Date("2026-01-01T14:00:00.000Z"),
                status: "PENDING",
                paymentStatus: PaymentStatus.UNPAID,
              },
            ],
          }),
        ],
        true,
        policyNow,
      );

      expect(results.get("leg-1")).toEqual(ineligible);
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
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
    it("replays the original response without another transaction or Flutterwave call", async () => {
      const replayResponse = {
        extensionId: "ext-original",
        paymentIntentId: "ext-idem-original",
        checkoutUrl: "https://checkout.flutterwave.com/pay/original",
      };
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      idempotencyServiceMock.claim.mockResolvedValueOnce({
        kind: "replay",
        response: replayResponse,
      });

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-1"),
      ).resolves.toEqual(replayResponse);

      expect(databaseServiceMock.$transaction).not.toHaveBeenCalled();
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("replays an omitted-leg request using its originally resolved leg after midnight", async () => {
      const replayResponse = {
        extensionId: "ext-original",
        paymentIntentId: "ext-idem-original",
        checkoutUrl: "https://checkout.flutterwave.com/pay/original",
      };
      databaseServiceMock.$queryRaw.mockResolvedValueOnce([
        { policyNow: new Date("2026-01-02T10:00:00.000Z") },
      ]);
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(
        buildBooking({
          legs: [
            {
              id: "leg-original",
              legDate: todayLegDate,
              legEndTime: new Date("2026-01-01T20:00:00.000Z"),
            },
            {
              id: "leg-new-day",
              legDate: tomorrowLegDate,
              legEndTime: new Date("2026-01-02T20:00:00.000Z"),
            },
          ],
        }),
      );
      idempotencyServiceMock.findResolvedBookingLegId.mockResolvedValueOnce("leg-original");
      idempotencyServiceMock.claim.mockResolvedValueOnce({
        kind: "replay",
        response: replayResponse,
      });

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-1"),
      ).resolves.toEqual(replayResponse);

      expect(idempotencyServiceMock.createRequestHash).toHaveBeenCalledWith(
        expect.objectContaining({ bookingLegId: "leg-original" }),
      );
      expect(databaseServiceMock.$transaction).not.toHaveBeenCalled();
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("resumes a leased provider request with the original payment reference", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      idempotencyServiceMock.claim.mockResolvedValueOnce({
        kind: "resume",
        id: "idem-1",
        extensionId: "ext-1",
      });
      databaseServiceMock.extension.findUnique.mockResolvedValueOnce({
        id: "ext-1",
        totalAmount: new Decimal(10000),
        paymentIntent: "ext-idem-1",
        paymentSessionExpiresAt: new Date("2026-01-01T10:10:00.000Z"),
        paymentStatus: PaymentStatus.UNPAID,
        status: "PENDING",
        bookingLegId: "leg-1",
        bookingLeg: {
          booking: {
            id: "booking-1",
            status: BookingStatus.ACTIVE,
            userId: "user-1",
          },
        },
      });

      const result = await service.createExtension(
        "booking-1",
        extensionCallback,
        authUser,
        "extension-request-1",
      );

      expect(databaseServiceMock.$transaction).not.toHaveBeenCalled();
      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
      expect(flutterwaveServiceMock.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "ext-idem-1" }),
      );
      expect(idempotencyServiceMock.checkpointResponse).toHaveBeenCalledWith(
        "idem-1",
        "ext-1",
        result,
      );
    });

    it("does not recreate checkout for an already confirmed extension", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      idempotencyServiceMock.claim.mockResolvedValueOnce({
        kind: "resume",
        id: "idem-1",
        extensionId: "ext-1",
      });
      databaseServiceMock.extension.findUnique.mockResolvedValueOnce({
        id: "ext-1",
        totalAmount: new Decimal(10000),
        paymentIntent: "ext-idem-1",
        paymentSessionExpiresAt: new Date("2026-01-01T10:10:00.000Z"),
        paymentStatus: PaymentStatus.PAID,
        status: "ACTIVE",
        bookingLegId: "leg-1",
        bookingLeg: {
          booking: {
            id: "booking-1",
            status: BookingStatus.COMPLETED,
            userId: "user-1",
          },
        },
      });

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-1"),
      ).rejects.toBeInstanceOf(ExtensionAlreadyConfirmedException);

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("does not resume checkout after the parent booking becomes inactive", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      idempotencyServiceMock.claim.mockResolvedValueOnce({
        kind: "resume",
        id: "idem-1",
        extensionId: "ext-1",
      });
      databaseServiceMock.extension.findUnique.mockResolvedValueOnce({
        id: "ext-1",
        totalAmount: new Decimal(10000),
        paymentIntent: "ext-idem-1",
        paymentSessionExpiresAt: new Date("2026-01-01T10:10:00.000Z"),
        paymentStatus: PaymentStatus.UNPAID,
        status: "PENDING",
        bookingLegId: "leg-1",
        bookingLeg: {
          booking: {
            id: "booking-1",
            status: BookingStatus.CANCELLED,
            userId: "user-1",
          },
        },
      });

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-1"),
      ).rejects.toBeInstanceOf(ExtensionPaymentSessionExpiredException);

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("creates extension payment intent for active hourly booking", async () => {
      const legEndTime = new Date(policyNow.getTime() + 60 * 60 * 1000);
      const booking = buildBooking({ legDate: policyNow, legEndTime });

      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce(booking);
      databaseServiceMock.extension.create.mockResolvedValueOnce({
        id: "ext-1",
      });

      const result = await service.createExtension(
        "booking-1",
        { hours: 2, callbackUrl: extensionCallback.callbackUrl },
        authUser,
        "extension-request-1",
      );

      expect(result).toEqual({
        extensionId: "ext-1",
        paymentIntentId: "ext-idem-1",
        checkoutUrl: "https://checkout.flutterwave.com/pay/ext-001",
      });
      expect(flutterwaveServiceMock.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: "booking_extension",
          callbackUrl: "https://example.com/callback",
          idempotencyKey: "ext-idem-1",
          sessionDurationMinutes: 10,
          metadata: expect.objectContaining({
            extensionId: "ext-1",
            bookingLegId: "leg-1",
          }),
        }),
      );
      expect(databaseServiceMock.extension.create).toHaveBeenCalled();
      expect(databaseServiceMock.extension.create.mock.invocationCallOrder[0]).toBeLessThan(
        flutterwaveServiceMock.createPaymentIntent.mock.invocationCallOrder[0],
      );
      expect(idempotencyServiceMock.attachExtension.mock.invocationCallOrder[0]).toBeLessThan(
        flutterwaveServiceMock.createPaymentIntent.mock.invocationCallOrder[0],
      );
      expect(idempotencyServiceMock.checkpointResponse).toHaveBeenCalledWith(
        "idem-1",
        "ext-1",
        result,
      );
      expect(idempotencyServiceMock.complete).toHaveBeenCalledWith("idem-1");
      expect(databaseServiceMock.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: "booking-1",
          endDate: { lt: new Date("2026-01-01T13:00:00.000Z") },
        },
        data: { endDate: new Date("2026-01-01T13:00:00.000Z") },
      });
      expect(databaseServiceMock.extension.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentSessionExpiresAt: new Date("2026-01-01T10:10:00.000Z"),
          }),
        }),
      );
    });

    it("uses today's leg when bookingLegId is omitted for a multi-day booking", async () => {
      const booking = buildBooking({
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
      });
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce({
        ...booking,
        legs: booking.legs.filter((leg) => leg.id === "leg-today"),
      });
      databaseServiceMock.extension.create.mockResolvedValueOnce({ id: "ext-1" });

      await service.createExtension(
        "booking-1",
        extensionCallback,
        authUser,
        "extension-request-1",
      );

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
      const booking = buildBooking({
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
      });
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce({
        ...booking,
        legs: booking.legs.filter((leg) => leg.id === "leg-tomorrow"),
      });
      databaseServiceMock.extension.create.mockResolvedValueOnce({ id: "ext-future" });

      await service.createExtension(
        "booking-1",
        {
          hours: 2,
          callbackUrl: extensionCallback.callbackUrl,
          bookingLegId: "leg-tomorrow",
        },
        authUser,
        "extension-request-1",
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
          "extension-request-1",
        ),
      ).rejects.toThrow("Booking leg not found");

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
    });

    it("rejects a past or ended bookingLegId before creating a payment intent", async () => {
      const booking = buildBooking({
        legs: [
          {
            id: "leg-ended-today",
            legDate: todayLegDate,
            legEndTime: new Date("2026-01-01T09:00:00.000Z"),
          },
        ],
      });
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce(booking);

      await expect(
        service.createExtension(
          "booking-1",
          {
            hours: 1,
            callbackUrl: extensionCallback.callbackUrl,
            bookingLegId: "leg-ended-today",
          },
          authUser,
          "extension-request-1",
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
          "extension-request-1",
        ),
      ).rejects.toThrow("Maximum extension is 1 hour(s) for this leg");

      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
    });

    it("throws when active booking is not found", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createExtension(
          "missing-booking",
          extensionCallback,
          authUser,
          "extension-request-1",
        ),
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
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-1"),
      ).rejects.toThrow("Only DAY bookings can be extended");
      expect(databaseServiceMock.booking.findMany).not.toHaveBeenCalled();
    });

    it("rejects rather than replacing an existing pending unpaid extension", async () => {
      const legEndTime = new Date(policyNow.getTime() + 2 * 60 * 60 * 1000);
      const pendingExtensionEnd = new Date(legEndTime.getTime() + 1 * 60 * 60 * 1000);

      const booking = buildBooking({
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
      });
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce(booking);

      await expect(
        service.createExtension(
          "booking-1",
          { hours: 2, callbackUrl: extensionCallback.callbackUrl },
          authUser,
          "extension-request-2",
        ),
      ).rejects.toBeInstanceOf(ExtensionPaymentPendingException);

      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(idempotencyServiceMock.release).toHaveBeenCalledWith("idem-1");
    });

    it("rejects if the effective leg end changes before the locked write", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce(
        buildBooking({ legEndTime: new Date("2026-01-01T14:00:00.000Z") }),
      );

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-3"),
      ).rejects.toBeInstanceOf(ExtensionStateChangedException);

      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(idempotencyServiceMock.release).toHaveBeenCalledWith("idem-1");
    });

    it("rejects if the booking becomes cancelled before the locked write", async () => {
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(buildBooking());
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce(
        buildBooking({ status: BookingStatus.CANCELLED }),
      );

      await expect(
        service.createExtension("booking-1", extensionCallback, authUser, "extension-request-3"),
      ).rejects.toThrow("Confirmed or active booking not found");

      expect(databaseServiceMock.extension.create).not.toHaveBeenCalled();
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
      expect(idempotencyServiceMock.release).toHaveBeenCalledWith("idem-1");
    });

    it("throws when requested extension exceeds the leg max hours", async () => {
      const twoHoursToMidnight = new Date("2026-01-01T22:00:00.000Z");

      const booking = buildBooking({
        legEndTime: twoHoursToMidnight,
        extensions: [
          {
            extensionDate: policyNow,
            extensionEndTime: twoHoursToMidnight,
            status: "ACTIVE",
            paymentStatus: PaymentStatus.PAID,
          },
        ],
      });
      databaseServiceMock.booking.findFirst.mockResolvedValueOnce(booking);
      databaseServiceMock.booking.findUnique.mockResolvedValueOnce(booking);

      await expect(
        service.createExtension(
          "booking-1",
          { hours: 3, callbackUrl: extensionCallback.callbackUrl },
          authUser,
          "extension-request-1",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(flutterwaveServiceMock.createPaymentIntent).not.toHaveBeenCalled();
    });
  });
});
