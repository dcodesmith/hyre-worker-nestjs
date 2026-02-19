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
      update: vi.fn(),
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
    txMock.bookingLeg.update.mockResolvedValueOnce({});
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
    expect(queueMock.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
        channels: [NotificationChannel.EMAIL],
      }),
    );
  });

  it("returns false when extension is already processed", async () => {
    txMock.extension.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.confirmFromPayment({
      id: "payment-1",
      txRef: "tx-1",
      extensionId: "extension-1",
    } as never);

    expect(result).toBe(false);
    expect(queueMock.add).not.toHaveBeenCalled();
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
