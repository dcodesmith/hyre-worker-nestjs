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
} from "./booking.error";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { BookingUpdateService } from "./booking-update.service";
import { BookingValidationService } from "./booking-validation.service";

describe("BookingUpdateService", () => {
  let service: BookingUpdateService;

  const databaseServiceMock = {
    booking: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };

  const bookingValidationServiceMock = {
    validateDates: vi.fn(),
    checkCarAvailability: vi.fn(),
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
    assertCanEdit: vi.fn(),
    assertWithinWindow: vi.fn(),
    getStartDateThreshold: vi.fn((now: Date) => new Date(now.getTime() + 12 * 60 * 60 * 1000)),
    getEligibility: vi.fn().mockReturnValue({
      canEdit: true,
      canCancel: true,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
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
          $queryRaw: typeof databaseServiceMock.$queryRaw;
        }) => Promise<unknown>,
      ) =>
        callback({
          booking: databaseServiceMock.booking,
          $queryRaw: databaseServiceMock.$queryRaw,
        }),
    );
    databaseServiceMock.$queryRaw.mockImplementation((query: TemplateStringsArray) =>
      query.join("").includes("clock_timestamp")
        ? [{ policyNow: new Date() }]
        : [{ id: "booking-1" }],
    );
    databaseServiceMock.booking.updateMany.mockResolvedValue({ count: 1 });
    notificationOutboxServiceMock.create.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingUpdateService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: BookingValidationService, useValue: bookingValidationServiceMock },
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

    await service.updateBooking("booking-1", "user-1", {
      pickupAddress: "New pickup",
    });

    expect(databaseServiceMock.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "booking-1",
          userId: "user-1",
          status: BookingStatus.CONFIRMED,
        }),
        data: expect.objectContaining({
          pickupLocation: "New pickup",
        }),
      }),
    );
    expect(notificationOutboxServiceMock.create).toHaveBeenCalledWith(
      bookingUpdatedHandlerMock,
      {
        booking: { id: "booking-1" },
        actor: { type: "user", userId: "user-1" },
      },
      {
        booking: databaseServiceMock.booking,
        $queryRaw: databaseServiceMock.$queryRaw,
      },
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
    );
    expect(bookingModificationPolicyServiceMock.assertCanEdit).toHaveBeenCalledTimes(2);
    expect(bookingModificationPolicyServiceMock.assertWithinWindow).toHaveBeenCalledTimes(2);
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
    databaseServiceMock.booking.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingStatusNotModifiableException);
    expect(databaseServiceMock.booking.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rejects the update when the cutoff expires before the guarded write", async () => {
    const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
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
      .mockResolvedValueOnce([{ policyNow: new Date(startDate.getTime() - 12 * 60 * 60 * 1000) }]);

    await expect(
      service.updateBooking("booking-1", "user-1", { pickupAddress: "New pickup" }),
    ).rejects.toBeInstanceOf(BookingOutsideModificationWindowException);
    expect(databaseServiceMock.booking.updateMany).not.toHaveBeenCalled();
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

    const result = await service.updateBooking("booking-1", "user-1", {
      pickupAddress: "Old pickup",
    });

    expect(databaseServiceMock.booking.updateMany).not.toHaveBeenCalled();
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
