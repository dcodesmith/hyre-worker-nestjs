import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, ChauffeurApprovalStatus, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingUpdatedHandler } from "../notification/handlers/booking-updated.handler";
import { ChauffeurAssignedHandler } from "../notification/handlers/chauffeur-assigned.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import {
  BookingChauffeurNotFoundException,
  BookingNotFoundException,
  BookingOutsideModificationWindowException,
  BookingStatusNotModifiableException,
  BookingUpdateFailedException,
  BookingUpdateNotAllowedException,
  BookingValidationException,
  CarNotAvailableException,
  ExtensionPaymentPendingException,
} from "./booking.error";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { BookingReservationService } from "./booking-reservation.service";
import { BookingUpdateService } from "./booking-update.service";
import { BookingValidationService } from "./booking-validation.service";

function getQueryText(query: unknown): string {
  if (Array.isArray(query)) {
    return query.join("");
  }
  if (query && typeof query === "object" && "strings" in query) {
    return (query as { strings: string[] }).strings.join("");
  }
  return String(query);
}

describe("BookingUpdateService", () => {
  let service: BookingUpdateService;

  const databaseServiceMock = {
    booking: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    extension: {
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const transactionMock = {
    booking: databaseServiceMock.booking,
    extension: databaseServiceMock.extension,
    $queryRaw: databaseServiceMock.$queryRaw,
  };

  const bookingValidationServiceMock = {
    validateDates: vi.fn(),
    checkCarAvailability: vi.fn(),
  };
  const bookingReservationServiceMock = {
    isOverlapConstraintViolation: vi.fn().mockReturnValue(false),
  };

  const notificationOutboxServiceMock = {
    create: vi.fn(),
  };

  const chauffeurAssignedHandlerMock = {
    eventType: "BOOKING_ASSIGNMENT" as const,
    buildEvents: vi.fn(),
  };

  const bookingUpdatedHandlerMock = {
    eventType: "BOOKING_LIFECYCLE" as const,
    buildEvents: vi.fn(),
  };
  const bookingModificationPolicyServiceMock = {
    assertEditableStatus: vi.fn(),
    assertCanEdit: vi.fn(),
    assertWithinWindow: vi.fn(),
    getModificationCutoffAt: vi.fn(
      (startDate: Date) => new Date(startDate.getTime() - 12 * 60 * 60 * 1000),
    ),
    getEligibility: vi.fn().mockReturnValue({
      canEdit: true,
      canCancel: true,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.extension.findFirst.mockResolvedValue(null);
    bookingModificationPolicyServiceMock.assertEditableStatus.mockImplementation(
      (booking: { status: BookingStatus }) => {
        if (booking.status !== BookingStatus.CONFIRMED) {
          throw new BookingStatusNotModifiableException(
            "edit",
            "Only confirmed bookings can be edited",
          );
        }
      },
    );
    bookingModificationPolicyServiceMock.assertCanEdit.mockImplementation(
      (booking: { status: BookingStatus; startDate: Date }, now = new Date()) => {
        if (booking.status !== BookingStatus.CONFIRMED) {
          throw new BookingStatusNotModifiableException(
            "edit",
            "Only confirmed bookings can be edited",
          );
        }
        if (now.getTime() >= booking.startDate.getTime() - 12 * 60 * 60 * 1000) {
          throw new BookingOutsideModificationWindowException(
            new Date(booking.startDate.getTime() - 12 * 60 * 60 * 1000),
            12,
          );
        }
      },
    );
    bookingModificationPolicyServiceMock.assertWithinWindow.mockImplementation(
      (startDate: Date, now = new Date()) => {
        if (now.getTime() >= startDate.getTime() - 12 * 60 * 60 * 1000) {
          throw new BookingOutsideModificationWindowException(
            new Date(startDate.getTime() - 12 * 60 * 60 * 1000),
            12,
          );
        }
      },
    );
    databaseServiceMock.$transaction.mockImplementation(
      (
        callback: (tx: {
          booking: typeof databaseServiceMock.booking;
          extension: typeof databaseServiceMock.extension;
          $queryRaw: typeof databaseServiceMock.$queryRaw;
        }) => Promise<unknown>,
      ) => callback(transactionMock),
    );
    databaseServiceMock.$queryRaw.mockImplementation((query: unknown) => {
      const queryText = getQueryText(query);
      if (queryText.includes('UPDATE "Booking"')) {
        return [{ id: "booking-1" }];
      }
      return queryText.includes('SELECT clock_timestamp() AS "policyNow"')
        ? [{ policyNow: new Date() }]
        : [{ id: "booking-1" }];
    });
    notificationOutboxServiceMock.create.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingUpdateService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: BookingValidationService, useValue: bookingValidationServiceMock },
        { provide: BookingReservationService, useValue: bookingReservationServiceMock },
        {
          provide: BookingModificationPolicyService,
          useValue: bookingModificationPolicyServiceMock,
        },
        { provide: NotificationOutboxService, useValue: notificationOutboxServiceMock },
        { provide: ChauffeurAssignedHandler, useValue: chauffeurAssignedHandlerMock },
        { provide: BookingUpdatedHandler, useValue: bookingUpdatedHandlerMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<BookingUpdateService>(BookingUpdateService);
  });

  it("updates booking pickup location", async () => {
    const policyNow = new Date("2026-08-01T23:59:58.000Z");
    const responseNow = new Date("2026-08-01T23:59:59.000Z");
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.booking.findUniqueOrThrow.mockResolvedValueOnce({ id: "booking-1" });
    databaseServiceMock.$queryRaw
      .mockResolvedValueOnce([{ id: "booking-1" }])
      .mockResolvedValueOnce([{ policyNow }])
      .mockResolvedValueOnce([{ id: "booking-1" }])
      .mockResolvedValueOnce([{ policyNow: responseNow }]);

    await service.updateBooking("booking-1", "user-1", {
      pickupAddress: "New pickup",
    });

    const updateQuery = databaseServiceMock.$queryRaw.mock.calls.find(([query]) =>
      getQueryText(query).includes('UPDATE "Booking"'),
    )?.[0];
    expect(getQueryText(updateQuery)).toContain("clock_timestamp() <");
    expect(updateQuery).toEqual(
      expect.objectContaining({
        values: expect.arrayContaining([
          "booking-1",
          "user-1",
          BookingStatus.CONFIRMED,
          "New pickup",
        ]),
      }),
    );
    expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
      { id: "booking-1" },
      true,
      responseNow,
    );
    expect(notificationOutboxServiceMock.create).toHaveBeenCalledWith(
      bookingUpdatedHandlerMock,
      {
        booking: { id: "booking-1" },
        actor: { type: "user", userId: "user-1" },
      },
      transactionMock,
    );
  });

  it("updates booking pickup time for DAY and checks availability", async () => {
    const startDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate,
      endDate: new Date(startDate.getTime() + 12 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.booking.findUniqueOrThrow.mockResolvedValueOnce({ id: "booking-1" });

    await service.updateBooking("booking-1", "user-1", {
      pickupTime: "10:30 AM",
    });

    expect(bookingValidationServiceMock.validateDates).toHaveBeenCalled();
    expect(bookingValidationServiceMock.checkCarAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        carId: "car-1",
        excludeBookingId: "booking-1",
      }),
      transactionMock,
    );
    expect(bookingModificationPolicyServiceMock.assertCanEdit).toHaveBeenCalledOnce();
    expect(bookingModificationPolicyServiceMock.assertWithinWindow).toHaveBeenCalledOnce();
  });

  it("rejects date changes while an extension payment is pending", async () => {
    const startDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate,
      endDate: new Date(startDate.getTime() + 12 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.extension.findFirst.mockResolvedValueOnce({ bookingLegId: "leg-1" });

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupTime: "10:30 AM" }),
    ).rejects.toBeInstanceOf(ExtensionPaymentPendingException);

    expect(bookingValidationServiceMock.checkCarAvailability).not.toHaveBeenCalled();
    expect(databaseServiceMock.booking.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("throws when booking does not exist for user", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.updateBooking("missing", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("throws when booking is not confirmed", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.COMPLETED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingStatusNotModifiableException);
  });

  it("rejects the update when booking state changes before persistence", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingStatusNotModifiableException);
    expect(databaseServiceMock.booking.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rejects the update when the database cutoff expires inside the guarded write", async () => {
    const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const modificationCutoffAt = new Date(startDate.getTime() - 12 * 60 * 60 * 1000);
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate,
      endDate: new Date(startDate.getTime() + 12 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.$queryRaw
      .mockResolvedValueOnce([{ id: "booking-1" }])
      .mockResolvedValueOnce([{ policyNow: new Date(modificationCutoffAt.getTime() - 1) }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ policyNow: modificationCutoffAt }]);

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingOutsideModificationWindowException);
    const updateQuery = databaseServiceMock.$queryRaw.mock.calls[2]?.[0];
    expect(getQueryText(updateQuery)).toContain("clock_timestamp() <");
  });

  it("throws validation error for pickupTime on unsupported booking type", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "NIGHT",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupTime: "10 AM" }),
    ).rejects.toBeInstanceOf(BookingValidationException);
  });

  it("throws booking update failed for unexpected errors", async () => {
    databaseServiceMock.booking.findFirst.mockRejectedValueOnce(new Error("DB unavailable"));

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingUpdateFailedException);
  });

  it("maps a database overlap constraint to car not available", async () => {
    const startDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate,
      endDate: new Date(startDate.getTime() + 12 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    bookingReservationServiceMock.isOverlapConstraintViolation.mockReturnValueOnce(true);
    databaseServiceMock.$transaction.mockRejectedValueOnce(new Error("23P01"));

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupTime: "10:30 AM" }),
    ).rejects.toBeInstanceOf(CarNotAvailableException);
  });

  it("fails the update transaction when durable notification creation fails", async () => {
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    });
    databaseServiceMock.booking.findUniqueOrThrow.mockResolvedValueOnce({ id: "booking-1" });
    notificationOutboxServiceMock.create.mockRejectedValueOnce(new Error("Outbox unavailable"));

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingUpdateFailedException);
  });

  it("returns current booking when no changes detected", async () => {
    const policyNow = new Date("2026-08-01T23:59:59.999Z");
    const baseBooking = {
      id: "booking-1",
      userId: "user-1",
      carId: "car-1",
      type: "DAY",
      status: BookingStatus.CONFIRMED,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 36 * 60 * 60 * 1000),
      pickupLocation: "Old pickup",
      returnLocation: "Old return",
    };
    databaseServiceMock.booking.findFirst.mockResolvedValueOnce(baseBooking);
    databaseServiceMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      paymentStatus: PaymentStatus.PAID,
    });
    databaseServiceMock.$queryRaw.mockResolvedValueOnce([{ policyNow }]);

    const result = await service.updateBooking("booking-1", "user-1", {
      pickupAddress: "Old pickup",
    });

    expect(
      databaseServiceMock.$queryRaw.mock.calls.some(([query]) =>
        getQueryText(query).includes('UPDATE "Booking"'),
      ),
    ).toBe(false);
    expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-1" }),
      true,
      policyNow,
    );
    expect(result).toEqual({
      id: "booking-1",
      paymentStatus: PaymentStatus.PAID,
      canEdit: true,
      canCancel: true,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    });
  });

  describe("assignChauffeur", () => {
    it("assigns approved chauffeur belonging to fleet owner", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: null,
            flightId: "flight-1",
            status: BookingStatus.CONFIRMED,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: "chauffeur-1",
            status: BookingStatus.CONFIRMED,
          }),
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: "chauffeur-1",
            chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
          }),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      const result = await service.assignChauffeur("booking-1", "owner-1", "chauffeur-1");

      expect(result).toEqual({
        id: "booking-1",
        chauffeurId: "chauffeur-1",
        status: BookingStatus.CONFIRMED,
      });
      expect(tx.booking.findFirst).toHaveBeenCalledWith({
        where: {
          id: "booking-1",
          deletedAt: null,
          car: { ownerId: "owner-1" },
        },
        select: {
          id: true,
          chauffeurId: true,
          flightId: true,
          status: true,
        },
      });
      expect(tx.user.findFirst).toHaveBeenCalledWith({
        where: {
          id: "chauffeur-1",
          fleetOwnerId: "owner-1",
        },
        select: {
          id: true,
          chauffeurApprovalStatus: true,
        },
      });
      expect(tx.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "booking-1",
            deletedAt: null,
            status: BookingStatus.CONFIRMED,
            chauffeurId: null,
            car: { ownerId: "owner-1" },
          },
          data: { chauffeurId: "chauffeur-1" },
        }),
      );
      expect(tx.booking.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "booking-1" },
        }),
      );
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(notificationOutboxServiceMock.create).toHaveBeenCalledWith(
        chauffeurAssignedHandlerMock,
        { booking: result, chauffeurId: "chauffeur-1" },
        tx,
      );
    });

    it("returns booking details for idempotent chauffeur assignment", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: "chauffeur-1",
            status: BookingStatus.CONFIRMED,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: "chauffeur-1",
          }),
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: "chauffeur-1",
            chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
          }),
        },
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      const result = await service.assignChauffeur("booking-1", "owner-1", "chauffeur-1");

      expect(result).toEqual({ id: "booking-1", chauffeurId: "chauffeur-1" });
      expect(tx.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "booking-1",
            deletedAt: null,
            status: BookingStatus.CONFIRMED,
            chauffeurId: "chauffeur-1",
            car: { ownerId: "owner-1" },
          },
          data: { chauffeurId: "chauffeur-1" },
        }),
      );
      expect(tx.booking.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "booking-1" },
        }),
      );
      expect(notificationOutboxServiceMock.create).not.toHaveBeenCalled();
    });

    it("throws when guarded write fails due to concurrent booking change", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: null,
            status: BookingStatus.CONFIRMED,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUniqueOrThrow: vi.fn(),
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: "chauffeur-1",
            chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
          }),
        },
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await expect(
        service.assignChauffeur("booking-1", "owner-1", "chauffeur-1"),
      ).rejects.toBeInstanceOf(BookingUpdateNotAllowedException);
      expect(tx.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("throws when booking is not owned by fleet owner", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn(),
          findUniqueOrThrow: vi.fn(),
        },
        user: { findFirst: vi.fn() },
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await expect(
        service.assignChauffeur("booking-1", "owner-1", "chauffeur-1"),
      ).rejects.toBeInstanceOf(BookingNotFoundException);
    });

    it("throws when booking is not in confirmed status", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: null,
            status: BookingStatus.ACTIVE,
          }),
          updateMany: vi.fn(),
          findUniqueOrThrow: vi.fn(),
        },
        user: { findFirst: vi.fn() },
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await expect(
        service.assignChauffeur("booking-1", "owner-1", "chauffeur-1"),
      ).rejects.toBeInstanceOf(BookingUpdateNotAllowedException);
      expect(tx.user.findFirst).not.toHaveBeenCalled();
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
    });

    it("throws when chauffeur is not found for fleet owner", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: null,
            status: BookingStatus.CONFIRMED,
          }),
          updateMany: vi.fn(),
          findUniqueOrThrow: vi.fn(),
        },
        user: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await expect(
        service.assignChauffeur("booking-1", "owner-1", "chauffeur-2"),
      ).rejects.toBeInstanceOf(BookingChauffeurNotFoundException);
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
    });

    it("throws when chauffeur is not approved", async () => {
      const tx = {
        booking: {
          findFirst: vi.fn().mockResolvedValue({
            id: "booking-1",
            chauffeurId: null,
            status: BookingStatus.CONFIRMED,
          }),
          updateMany: vi.fn(),
          findUniqueOrThrow: vi.fn(),
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: "chauffeur-2",
            chauffeurApprovalStatus: ChauffeurApprovalStatus.PENDING,
          }),
        },
      };
      databaseServiceMock.$transaction.mockImplementationOnce(
        (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await expect(
        service.assignChauffeur("booking-1", "owner-1", "chauffeur-2"),
      ).rejects.toBeInstanceOf(BookingUpdateNotAllowedException);
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
    });
  });
});
