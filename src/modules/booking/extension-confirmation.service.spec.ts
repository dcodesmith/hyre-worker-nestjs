import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingExtensionConfirmedHandler } from "../notification/handlers/booking-extension-confirmed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { BookingReservationService } from "./booking-reservation.service";
import { ExtensionConfirmationService } from "./extension-confirmation.service";

describe("ExtensionConfirmationService", () => {
  let service: ExtensionConfirmationService;
  let notificationOutboxService: NotificationOutboxService;
  let bookingExtensionConfirmedHandler: BookingExtensionConfirmedHandler;
  const outboxMock = { create: vi.fn() };
  const bookingReservationServiceMock = {
    isOverlapConstraintViolation: vi.fn().mockReturnValue(false),
  };
  const txMock = {
    $queryRaw: vi.fn(),
    extension: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    bookingLeg: {
      updateMany: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const databaseServiceMock = {
    $transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    txMock.$queryRaw.mockResolvedValue([{ id: "locked" }]);
    txMock.extension.findUnique.mockReset();
    txMock.extension.findUnique
      .mockResolvedValueOnce({
        bookingLegId: "leg-1",
        bookingLeg: {
          booking: {
            id: "booking-1",
            carId: "car-1",
          },
        },
      })
      .mockResolvedValueOnce({
        bookingLegId: "leg-1",
        extensionStartTime: new Date("2026-02-20T10:00:00.000Z"),
        extensionEndTime: new Date("2026-02-20T12:00:00.000Z"),
        paymentId: null,
        paymentStatus: PaymentStatus.UNPAID,
        status: "PENDING",
      });
    txMock.extension.findFirst.mockResolvedValue(null);
    txMock.booking.findUnique.mockResolvedValue({ status: "ACTIVE" });
    txMock.booking.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtensionConfirmationService,
        {
          provide: DatabaseService,
          useValue: databaseServiceMock,
        },
        {
          provide: NotificationOutboxService,
          useValue: outboxMock,
        },
        { provide: BookingExtensionConfirmedHandler, useValue: {} },
        { provide: BookingReservationService, useValue: bookingReservationServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<ExtensionConfirmationService>(ExtensionConfirmationService);
    notificationOutboxService = module.get(NotificationOutboxService);
    bookingExtensionConfirmedHandler = module.get(BookingExtensionConfirmedHandler);
  });

  it("confirms pending extension and queues confirmation email", async () => {
    txMock.extension.updateMany.mockResolvedValueOnce({ count: 1 });
    txMock.extension.findUnique.mockResolvedValueOnce({
      id: "extension-1",
      bookingLegId: "leg-1",
      extendedDurationHours: 2,
      extensionStartTime: new Date("2026-02-20T10:00:00.000Z"),
      extensionEndTime: new Date("2026-02-20T12:00:00.000Z"),
      bookingLeg: {
        id: "leg-1",
        legDate: new Date("2026-02-20T00:00:00.000Z"),
        legEndTime: new Date("2026-02-20T10:00:00.000Z"),
        booking: {
          id: "booking-1",
          userId: "customer-1",
          bookingReference: "BOOK-1",
          status: "PENDING",
          pickupLocation: "A",
          returnLocation: "B",
          startDate: new Date("2026-02-20T08:00:00.000Z"),
          endDate: new Date("2026-02-20T10:00:00.000Z"),
          totalAmount: { toFixed: () => "10000.00" },
          cancellationReason: null,
          user: { name: "Test User", email: "test@example.com", phoneNumber: "+2348000000000" },
          guestUser: null,
          chauffeur: null,
          car: {
            make: "Toyota",
            model: "Camry",
            year: 2022,
            owner: { name: "Owner", username: null, email: "owner@example.com" },
          },
          legs: [{ extensions: [] }],
        },
      },
    });
    txMock.bookingLeg.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: "extension-1",
    } as never);

    expect(result).toBe(true);
    expect(txMock.extension.updateMany).toHaveBeenCalledWith({
      where: {
        id: "extension-1",
        status: { in: ["PENDING", "CANCELLED"] },
        paymentStatus: PaymentStatus.UNPAID,
      },
      data: {
        paymentId: "payment-1",
        paymentStatus: PaymentStatus.PAID,
        status: "ACTIVE",
      },
    });
    expect(txMock.bookingLeg.updateMany).toHaveBeenCalledWith({
      where: {
        id: "leg-1",
        legEndTime: {
          lt: new Date("2026-02-20T12:00:00.000Z"),
        },
      },
      data: { legEndTime: new Date("2026-02-20T12:00:00.000Z") },
    });
    expect(txMock.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        endDate: { lt: new Date("2026-02-20T12:00:00.000Z") },
      },
      data: { endDate: new Date("2026-02-20T12:00:00.000Z") },
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      bookingExtensionConfirmedHandler,
      {
        extension: expect.objectContaining({
          id: "extension-1",
          bookingLeg: expect.objectContaining({
            booking: expect.objectContaining({
              endDate: new Date("2026-02-20T12:00:00.000Z"),
            }),
          }),
        }),
      },
      txMock,
    );
  });

  it("writes a guest extension confirmation to the outbox transaction", async () => {
    txMock.extension.updateMany.mockResolvedValueOnce({ count: 1 });
    txMock.extension.findUnique.mockResolvedValueOnce({
      id: "extension-2",
      bookingLegId: "leg-2",
      extendedDurationHours: 1,
      extensionStartTime: new Date("2026-02-20T10:00:00.000Z"),
      extensionEndTime: new Date("2026-02-20T11:00:00.000Z"),
      bookingLeg: {
        id: "leg-2",
        legDate: new Date("2026-02-20T00:00:00.000Z"),
        legEndTime: new Date("2026-02-20T10:00:00.000Z"),
        booking: {
          id: "booking-2",
          bookingReference: "BOOK-2",
          status: "ACTIVE",
          pickupLocation: "A",
          returnLocation: "B",
          startDate: new Date("2026-02-20T08:00:00.000Z"),
          endDate: new Date("2026-02-20T10:00:00.000Z"),
          totalAmount: { toFixed: () => "10000.00" },
          cancellationReason: null,
          user: null,
          guestUser: {
            name: "WhatsApp Guest",
            email: "whatsapp.2348012345678@tripdly.com",
            phoneNumber: "+2348012345678",
            guestContactSource: "WHATSAPP_AGENT",
            preferredNotificationChannel: "WHATSAPP_ONLY",
          },
          chauffeur: null,
          car: {
            make: "Toyota",
            model: "Camry",
            year: 2022,
            owner: { name: "Owner", username: null, email: "owner@example.com" },
          },
          legs: [{ extensions: [] }],
        },
      },
    });
    txMock.bookingLeg.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.confirmFromPayment({
      id: "payment-2",
      txRef: "tx-2",
      extensionId: "extension-2",
    } as never);

    expect(result).toBe(true);
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      bookingExtensionConfirmedHandler,
      { extension: expect.objectContaining({ id: "extension-2" }) },
      txMock,
    );
  });

  it("does not regress legEndTime when a shorter extension is confirmed after a longer one", async () => {
    const laterLegEndTime = new Date("2026-02-20T15:00:00.000Z");
    const shorterExtensionEnd = new Date("2026-02-20T13:00:00.000Z");

    txMock.extension.updateMany.mockResolvedValueOnce({ count: 1 });
    txMock.extension.findUnique.mockResolvedValueOnce({
      id: "extension-short",
      bookingLegId: "leg-1",
      extendedDurationHours: 1,
      extensionStartTime: new Date("2026-02-20T12:00:00.000Z"),
      extensionEndTime: shorterExtensionEnd,
      bookingLeg: {
        id: "leg-1",
        legDate: new Date("2026-02-20T00:00:00.000Z"),
        legEndTime: laterLegEndTime,
        booking: {
          id: "booking-1",
          bookingReference: "BOOK-1",
          status: "ACTIVE",
          pickupLocation: "A",
          returnLocation: "B",
          startDate: new Date("2026-02-20T08:00:00.000Z"),
          endDate: new Date("2026-02-20T10:00:00.000Z"),
          totalAmount: { toFixed: () => "10000.00" },
          cancellationReason: null,
          user: { name: "Test User", email: "test@example.com", phoneNumber: "+2348000000000" },
          guestUser: null,
          chauffeur: null,
          car: {
            make: "Toyota",
            model: "Camry",
            year: 2022,
            owner: { name: "Owner", username: null, email: "owner@example.com" },
          },
          legs: [{ extensions: [] }],
        },
      },
    });
    const result = await service.confirmFromPayment({
      id: "payment-2",
      txRef: "tx-2",
      extensionId: "extension-short",
    } as never);

    expect(result).toBe(true);
    expect(txMock.bookingLeg.updateMany).toHaveBeenCalledWith({
      where: {
        id: "leg-1",
        legEndTime: { lt: shorterExtensionEnd },
      },
      data: { legEndTime: shorterExtensionEnd },
    });
    expect(txMock.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        endDate: { lt: shorterExtensionEnd },
      },
      data: { endDate: shorterExtensionEnd },
    });
    expect(notificationOutboxService.create).toHaveBeenCalled();
  });

  it("treats replay of the same active extension payment as confirmed", async () => {
    txMock.extension.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        bookingLegId: "leg-1",
        bookingLeg: {
          booking: {
            id: "booking-1",
            carId: "car-1",
          },
        },
      })
      .mockResolvedValueOnce({
        bookingLegId: "leg-1",
        extensionStartTime: new Date("2026-02-20T10:00:00.000Z"),
        extensionEndTime: new Date("2026-02-20T11:00:00.000Z"),
        paymentId: "payment-1",
        paymentStatus: PaymentStatus.PAID,
        status: "ACTIVE",
      });

    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: "extension-1",
    } as never);

    expect(result).toBe(true);
    expect(txMock.booking.findUnique).not.toHaveBeenCalled();
    expect(txMock.extension.updateMany).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("rejects late payment when another extension has replaced the cancelled window", async () => {
    txMock.extension.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        bookingLegId: "leg-1",
        bookingLeg: {
          booking: {
            id: "booking-1",
            carId: "car-1",
          },
        },
      })
      .mockResolvedValueOnce({
        bookingLegId: "leg-1",
        extensionStartTime: new Date("2026-02-20T10:00:00.000Z"),
        extensionEndTime: new Date("2026-02-20T11:00:00.000Z"),
        paymentId: null,
        paymentStatus: PaymentStatus.UNPAID,
        status: "CANCELLED",
      });
    txMock.extension.findFirst.mockResolvedValueOnce({ id: "replacement-extension" });

    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: "extension-1",
    } as never);

    expect(result).toBe(false);
    expect(txMock.extension.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: "extension-1" },
        bookingLegId: "leg-1",
        extensionStartTime: { lt: new Date("2026-02-20T11:00:00.000Z") },
        extensionEndTime: { gt: new Date("2026-02-20T10:00:00.000Z") },
        OR: [
          { status: "PENDING", paymentStatus: PaymentStatus.UNPAID },
          { status: "ACTIVE", paymentStatus: PaymentStatus.PAID },
        ],
      },
      select: { id: true },
    });
    expect(txMock.extension.updateMany).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("propagates outbox failures so the extension transaction can roll back", async () => {
    txMock.extension.updateMany.mockResolvedValueOnce({ count: 1 });
    txMock.extension.findUnique.mockResolvedValueOnce({
      id: "extension-1",
      bookingLegId: "leg-1",
      status: "ACTIVE",
      extensionEndTime: new Date("2026-02-20T12:00:00.000Z"),
      bookingLeg: {
        booking: {
          id: "booking-1",
          userId: "customer-1",
        },
      },
    });
    txMock.bookingLeg.updateMany.mockResolvedValueOnce({ count: 1 });
    outboxMock.create.mockRejectedValueOnce(new Error("Outbox write failed"));

    await expect(
      service.confirmFromPayment({
        id: "payment-1",
        txRef: "tx-1",
        extensionId: "extension-1",
      } as never),
    ).rejects.toThrow("Outbox write failed");
  });

  it("returns false when payment has no extension", async () => {
    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: null,
    } as never);

    expect(result).toBe(false);
    expect(databaseServiceMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns false for manual review when a late payment can no longer reserve the window", async () => {
    const overlapError = new Error("overlap");
    databaseServiceMock.$transaction.mockRejectedValueOnce(overlapError);
    bookingReservationServiceMock.isOverlapConstraintViolation.mockReturnValueOnce(true);

    await expect(
      service.confirmFromPayment({
        id: "payment-1",
        txRef: "tx-1",
        extensionId: "extension-1",
      } as never),
    ).resolves.toBe(false);
  });
});
