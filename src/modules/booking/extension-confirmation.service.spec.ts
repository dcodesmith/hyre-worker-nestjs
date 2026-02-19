import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { NotificationChannel, NotificationType } from "../notification/notification.interface";
import { ExtensionConfirmationService } from "./extension-confirmation.service";

describe("ExtensionConfirmationService", () => {
  let service: ExtensionConfirmationService;
  const queueMock = { add: vi.fn() };
  const txMock = {
    extension: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    bookingLeg: {
      updateMany: vi.fn(),
    },
  };
  const databaseServiceMock = {
    $transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtensionConfirmationService,
        {
          provide: DatabaseService,
          useValue: databaseServiceMock,
        },
        {
          provide: getQueueToken(NOTIFICATIONS_QUEUE),
          useValue: queueMock,
        },
      ],
    }).compile();

    service = module.get<ExtensionConfirmationService>(ExtensionConfirmationService);
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
    queueMock.add.mockResolvedValueOnce(undefined);

    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: "extension-1",
    } as never);

    expect(result).toBe(true);
    expect(txMock.extension.updateMany).toHaveBeenCalledWith({
      where: { id: "extension-1", status: "PENDING" },
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
    expect(queueMock.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
        channels: [NotificationChannel.EMAIL],
      }),
      expect.objectContaining({
        jobId: "booking-extension-confirmed-extension-1",
      }),
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
    queueMock.add.mockResolvedValueOnce(undefined);

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
    expect(queueMock.add).toHaveBeenCalled();
  });

  it("continues idempotently when extension is already active", async () => {
    txMock.extension.updateMany.mockResolvedValueOnce({ count: 0 });
    txMock.extension.findUnique.mockResolvedValueOnce({
      id: "extension-1",
      bookingLegId: "leg-1",
      status: "ACTIVE",
      extendedDurationHours: 1,
      extensionStartTime: new Date("2026-02-20T10:00:00.000Z"),
      extensionEndTime: new Date("2026-02-20T11:00:00.000Z"),
      bookingLeg: {
        id: "leg-1",
        legDate: new Date("2026-02-20T00:00:00.000Z"),
        legEndTime: new Date("2026-02-20T10:00:00.000Z"),
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
    txMock.bookingLeg.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: "extension-1",
    } as never);

    expect(result).toBe(true);
    expect(queueMock.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        id: "booking-extension-confirmed-extension-1",
      }),
      expect.objectContaining({
        jobId: "booking-extension-confirmed-extension-1",
      }),
    );
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
});
