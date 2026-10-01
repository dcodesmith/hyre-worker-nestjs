import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { reportBackgroundFailure } from "../../common/observability/background-operation";
import { BookingReservationService } from "../booking/booking-reservation.service";
import { ExtensionReservationService } from "../booking/extension-reservation.service";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { BookingReservationExpirationService } from "./booking-reservation-expiration.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";

const { reportBackgroundFailureMock, observeBackgroundOperationMock } = vi.hoisted(() => ({
  reportBackgroundFailureMock: vi.fn(),
  observeBackgroundOperationMock: vi.fn(
    async (_operation: string, _source: string, handler: () => Promise<unknown>) => handler(),
  ),
}));

vi.mock("../../common/observability/background-operation", () => ({
  reportBackgroundFailure: reportBackgroundFailureMock,
  observeBackgroundOperation: observeBackgroundOperationMock,
}));

const transaction = {
  id: 123,
  tx_ref: "booking-1",
  flw_ref: "flw-1",
  status: "successful",
  charged_amount: 10_000,
  amount: 10_000,
  currency: "NGN",
  payment_type: "card",
  created_at: "2026-08-02T20:00:00.000Z",
};

describe("BookingReservationExpirationService", () => {
  let service: BookingReservationExpirationService;
  const databaseService = {
    booking: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    extension: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  };
  const flutterwaveService = {
    findTransactionByReference: vi.fn(),
  };
  const bookingReservationService = {
    cancelExpiredReservation: vi.fn(),
  };
  const extensionReservationService = {
    cancelExpiredReservation: vi.fn(),
  };
  const chargeCompletedHandler = {
    handle: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseService.booking.findMany.mockResolvedValue([
      { id: "booking-1", paymentIntent: "booking-1" },
    ]);
    databaseService.extension.findMany.mockResolvedValue([]);
    databaseService.booking.updateMany.mockResolvedValue({ count: 1 });
    databaseService.extension.updateMany.mockResolvedValue({ count: 1 });
    databaseService.booking.findUnique.mockResolvedValue(null);
    databaseService.extension.findUnique.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReservationExpirationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: FlutterwaveService, useValue: flutterwaveService },
        { provide: BookingReservationService, useValue: bookingReservationService },
        { provide: ExtensionReservationService, useValue: extensionReservationService },
        { provide: ChargeCompletedHandler, useValue: chargeCompletedHandler },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(BookingReservationExpirationService);
  });

  it("confirms a successful payment instead of releasing the reservation", async () => {
    flutterwaveService.findTransactionByReference.mockResolvedValue(transaction);
    databaseService.booking.findUnique.mockResolvedValue({
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

    expect(chargeCompletedHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        tx_ref: "booking-1",
        status: "successful",
      }),
    );
    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    expect(databaseService.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      select: { status: true, paymentStatus: true },
    });
    expect(databaseService.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: "PENDING",
        paymentStatus: "UNPAID",
      },
      data: { paymentReconciliationCheckedAt: expect.any(Date) },
    });
    expect(databaseService.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              paymentSessionExpiresAt: null,
              createdAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
      }),
    );
  });

  it.each([null, { ...transaction, status: "failed" }])(
    "releases a reservation after Flutterwave confirms there is no successful payment",
    async (providerResult) => {
      flutterwaveService.findTransactionByReference.mockResolvedValue(providerResult);
      bookingReservationService.cancelExpiredReservation.mockResolvedValue(true);
      databaseService.booking.findUnique.mockResolvedValue({
        status: "CANCELLED",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

      expect(bookingReservationService.cancelExpiredReservation).toHaveBeenCalledWith("booking-1");
      expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
    },
  );

  it("retains the reservation when Flutterwave status is uncertain", async () => {
    flutterwaveService.findTransactionByReference.mockRejectedValue(new Error("provider timeout"));

    await expect(service.reconcileExpiredReservations()).resolves.toBe(0);

    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
    expect(reportBackgroundFailure).toHaveBeenCalledTimes(1);
    expect(reportBackgroundFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        message: "Failed to reconcile one or more expired reservations",
        operation: "BookingReservationExpirationService.reconcileExpiredReservations",
        source: "scheduler",
      }),
    );
    expect(databaseService.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { paymentReconciliationCheckedAt: { sort: "asc", nulls: "first" } },
          { paymentSessionExpiresAt: "asc" },
        ],
      }),
    );
  });

  it.each([new Error("provider timeout"), undefined])(
    "reports the first reservation error once per scheduled run",
    async (first) => {
      const second = new Error("network reset");
      databaseService.booking.findMany.mockResolvedValue([
        { id: "booking-1", paymentIntent: "booking-1" },
        { id: "booking-2", paymentIntent: "booking-2" },
      ]);
      flutterwaveService.findTransactionByReference
        .mockRejectedValueOnce(first)
        .mockRejectedValueOnce(second);

      await expect(service.reconcileExpiredReservations()).resolves.toBe(0);

      expect(reportBackgroundFailure).toHaveBeenCalledTimes(1);
      expect(reportBackgroundFailure).toHaveBeenCalledWith(
        first,
        expect.objectContaining({
          message: "Failed to reconcile one or more expired reservations",
        }),
      );
    },
  );

  it("retains the reservation while Flutterwave reports a non-terminal payment", async () => {
    flutterwaveService.findTransactionByReference.mockResolvedValue({
      ...transaction,
      status: "pending",
    });

    await expect(service.reconcileExpiredReservations()).resolves.toBe(0);

    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
  });

  it("reconciles one expired reservation on demand", async () => {
    databaseService.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      paymentIntent: "booking-1",
    });
    flutterwaveService.findTransactionByReference.mockResolvedValue(null);
    bookingReservationService.cancelExpiredReservation.mockResolvedValue(true);
    databaseService.booking.findUnique.mockResolvedValue({
      status: "CANCELLED",
      paymentStatus: "UNPAID",
    });

    await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("cancelled");

    expect(databaseService.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "booking-1",
          status: "PENDING",
          paymentStatus: "UNPAID",
        }),
      }),
    );
    expect(bookingReservationService.cancelExpiredReservation).toHaveBeenCalledWith("booking-1");
  });

  it("does not query Flutterwave when an on-demand reservation is not expired", async () => {
    databaseService.booking.findFirst.mockResolvedValue(null);
    databaseService.booking.findUnique.mockResolvedValue({
      status: "PENDING",
      paymentStatus: "UNPAID",
    });

    await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("retained");

    expect(flutterwaveService.findTransactionByReference).not.toHaveBeenCalled();
    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    expect(databaseService.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      select: { status: true, paymentStatus: true },
    });
  });

  it("reconciles both deterministic references when the stored payment intent is missing", async () => {
    databaseService.booking.findMany.mockResolvedValue([{ id: "booking-1", paymentIntent: null }]);
    flutterwaveService.findTransactionByReference.mockResolvedValue(null);
    bookingReservationService.cancelExpiredReservation.mockResolvedValue(true);
    databaseService.booking.findUnique.mockResolvedValue({
      status: "CANCELLED",
      paymentStatus: "UNPAID",
    });

    await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

    expect(flutterwaveService.findTransactionByReference).toHaveBeenNthCalledWith(1, "booking-1");
    expect(flutterwaveService.findTransactionByReference).toHaveBeenNthCalledWith(
      2,
      "booking_booking-1",
    );
    expect(bookingReservationService.cancelExpiredReservation).toHaveBeenCalledWith("booking-1");
  });

  it("completes payment when the fallback reference resolves a successful transaction", async () => {
    databaseService.booking.findMany.mockResolvedValue([{ id: "booking-1", paymentIntent: null }]);
    flutterwaveService.findTransactionByReference
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...transaction, tx_ref: "booking_booking-1" });
    databaseService.booking.findUnique.mockResolvedValue({
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

    expect(chargeCompletedHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ tx_ref: "booking_booking-1" }),
    );
    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
  });

  it("confirms a successful expired extension payment", async () => {
    databaseService.booking.findMany.mockResolvedValueOnce([]);
    databaseService.extension.findMany.mockResolvedValueOnce([
      { id: "extension-1", paymentIntent: "ext-idem-1" },
    ]);
    flutterwaveService.findTransactionByReference.mockResolvedValue({
      ...transaction,
      tx_ref: "ext-idem-1",
    });
    databaseService.extension.findUnique.mockResolvedValue({
      status: "ACTIVE",
      paymentStatus: "PAID",
    });

    await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

    expect(chargeCompletedHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ tx_ref: "ext-idem-1", status: "successful" }),
    );
    expect(extensionReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
  });

  it("releases an expired extension after Flutterwave confirms there is no payment", async () => {
    databaseService.booking.findMany.mockResolvedValueOnce([]);
    databaseService.extension.findMany.mockResolvedValueOnce([
      { id: "extension-1", paymentIntent: "ext-idem-1" },
    ]);
    flutterwaveService.findTransactionByReference.mockResolvedValue(null);
    extensionReservationService.cancelExpiredReservation.mockResolvedValue(true);
    databaseService.extension.findUnique.mockResolvedValue({
      status: "CANCELLED",
      paymentStatus: "UNPAID",
    });

    await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

    expect(extensionReservationService.cancelExpiredReservation).toHaveBeenCalledWith(
      "extension-1",
    );
    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
  });

  it("reconciles one expired extension on demand", async () => {
    databaseService.extension.findFirst.mockResolvedValue({
      id: "extension-1",
      paymentIntent: "ext-idem-1",
    });
    flutterwaveService.findTransactionByReference.mockResolvedValue(null);
    extensionReservationService.cancelExpiredReservation.mockResolvedValue(true);
    databaseService.extension.findUnique.mockResolvedValue({
      status: "CANCELLED",
      paymentStatus: "UNPAID",
    });

    await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("cancelled");

    expect(extensionReservationService.cancelExpiredReservation).toHaveBeenCalledWith(
      "extension-1",
    );
  });

  it("limits provider reconciliation to five concurrent reservations", async () => {
    databaseService.booking.findMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `booking-${index + 1}`,
        paymentIntent: `booking-${index + 1}`,
      })),
    );
    bookingReservationService.cancelExpiredReservation.mockResolvedValue(true);
    databaseService.booking.findUnique.mockResolvedValue({
      status: "CANCELLED",
      paymentStatus: "UNPAID",
    });

    let activeCalls = 0;
    let maxActiveCalls = 0;
    const releases: Array<() => void> = [];
    flutterwaveService.findTransactionByReference.mockImplementation(
      () =>
        new Promise((resolve) => {
          activeCalls += 1;
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
          releases.push(() => {
            activeCalls -= 1;
            resolve(null);
          });
        }),
    );

    const reconciliation = service.reconcileExpiredReservations();
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    expect(maxActiveCalls).toBe(5);

    for (const release of releases.splice(0)) release();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]();

    await expect(reconciliation).resolves.toBe(6);
    expect(maxActiveCalls).toBe(5);
  });

  it("skips a run while reconciliation is already in progress", async () => {
    let releaseQuery!: (reservations: Array<{ id: string; paymentIntent: string }>) => void;
    databaseService.booking.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseQuery = resolve;
        }),
    );

    const firstRun = service.reconcileExpiredReservations();
    await expect(service.reconcileExpiredReservations()).resolves.toBe(0);
    expect(databaseService.booking.findMany).toHaveBeenCalledTimes(1);

    releaseQuery([]);
    await expect(firstRun).resolves.toBe(0);
  });

  describe("authoritative persisted classification", () => {
    const bookingRows = {
      confirmed: { status: "CONFIRMED", paymentStatus: "PAID" },
      active: { status: "ACTIVE", paymentStatus: "PAID" },
      completed: { status: "COMPLETED", paymentStatus: "PAID" },
      cancelled: { status: "CANCELLED", paymentStatus: "UNPAID" },
    } as const;

    it.each([
      ["CONFIRMED", bookingRows.confirmed],
      ["ACTIVE", bookingRows.active],
      ["COMPLETED", bookingRows.completed],
    ] as const)(
      "classifies an already paid %s booking as confirmed without calling the provider",
      async (_label, row) => {
        databaseService.booking.findFirst.mockResolvedValue(null);
        databaseService.booking.findUnique.mockResolvedValue(row);

        await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("confirmed");

        expect(flutterwaveService.findTransactionByReference).not.toHaveBeenCalled();
        expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
        expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
      },
    );

    it("classifies an unpaid cancelled booking as cancelled", async () => {
      databaseService.booking.findFirst.mockResolvedValue(null);
      databaseService.booking.findUnique.mockResolvedValue(bookingRows.cancelled);

      await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("cancelled");

      expect(flutterwaveService.findTransactionByReference).not.toHaveBeenCalled();
      expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    });

    it.each([
      ["missing", null],
      ["paid but still pending", { status: "PENDING", paymentStatus: "PAID" }],
      ["unpaid but confirmed", { status: "CONFIRMED", paymentStatus: "UNPAID" }],
      ["paid and cancelled", { status: "CANCELLED", paymentStatus: "PAID" }],
      ["unpaid and pending", { status: "PENDING", paymentStatus: "UNPAID" }],
      ["refund processing", { status: "CONFIRMED", paymentStatus: "REFUND_PROCESSING" }],
      ["partially refunded", { status: "ACTIVE", paymentStatus: "PARTIALLY_REFUNDED" }],
      ["refunded", { status: "COMPLETED", paymentStatus: "REFUNDED" }],
      ["refund failed", { status: "CONFIRMED", paymentStatus: "REFUND_FAILED" }],
      ["paid but rejected", { status: "REJECTED", paymentStatus: "PAID" }],
    ] as const)("retains a booking in a %s state", async (_label, row) => {
      databaseService.booking.findFirst.mockResolvedValue(null);
      databaseService.booking.findUnique.mockResolvedValue(row);

      await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("retained");
    });

    it("retains a booking when a handled successful charge leaves the row pending", async () => {
      databaseService.booking.findFirst.mockResolvedValue({
        id: "booking-1",
        paymentIntent: "booking-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue(transaction);
      chargeCompletedHandler.handle.mockResolvedValue(undefined);
      databaseService.booking.findUnique.mockResolvedValue({
        status: "PENDING",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("retained");

      expect(chargeCompletedHandler.handle).toHaveBeenCalled();
      expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    });

    it("confirms a booking when a successful charge leaves it paid and confirmed", async () => {
      databaseService.booking.findFirst.mockResolvedValue({
        id: "booking-1",
        paymentIntent: "booking-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue(transaction);
      databaseService.booking.findUnique.mockResolvedValue(bookingRows.confirmed);

      await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("confirmed");

      expect(chargeCompletedHandler.handle).toHaveBeenCalled();
      expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    });

    it("classifies a cancellation from the persisted booking, not the cancel return value", async () => {
      databaseService.booking.findFirst.mockResolvedValue({
        id: "booking-1",
        paymentIntent: "booking-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue(null);
      bookingReservationService.cancelExpiredReservation.mockResolvedValue(false);
      databaseService.booking.findUnique.mockResolvedValue(bookingRows.cancelled);

      await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("cancelled");

      expect(bookingReservationService.cancelExpiredReservation).toHaveBeenCalledWith("booking-1");
    });

    it("retains a booking when cancellation does not persist an unpaid cancelled row", async () => {
      databaseService.booking.findFirst.mockResolvedValue({
        id: "booking-1",
        paymentIntent: "booking-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue(null);
      bookingReservationService.cancelExpiredReservation.mockResolvedValue(true);
      databaseService.booking.findUnique.mockResolvedValue({
        status: "PENDING",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe("retained");
    });

    it("counts confirmed and cancelled bookings and skips retained ones", async () => {
      databaseService.booking.findMany.mockResolvedValue([
        { id: "paid-confirmed", paymentIntent: "paid-confirmed" },
        { id: "unpaid-cancelled", paymentIntent: "unpaid-cancelled" },
        { id: "still-pending", paymentIntent: "still-pending" },
        { id: "provider-pending", paymentIntent: "provider-pending" },
      ]);
      flutterwaveService.findTransactionByReference.mockImplementation(
        async (reference: string) => {
          if (reference === "paid-confirmed" || reference === "still-pending") {
            return { ...transaction, tx_ref: reference };
          }
          if (reference === "provider-pending") {
            return { ...transaction, tx_ref: reference, status: "pending" };
          }
          return null;
        },
      );
      databaseService.booking.findUnique.mockImplementation(
        async (args: { where: { id: string } }) => {
          if (args.where.id === "paid-confirmed") return bookingRows.confirmed;
          if (args.where.id === "unpaid-cancelled") return bookingRows.cancelled;
          return { status: "PENDING", paymentStatus: "UNPAID" };
        },
      );

      await expect(service.reconcileExpiredReservations()).resolves.toBe(2);

      expect(chargeCompletedHandler.handle).toHaveBeenCalledTimes(2);
      expect(bookingReservationService.cancelExpiredReservation).toHaveBeenCalledTimes(1);
      expect(bookingReservationService.cancelExpiredReservation).toHaveBeenCalledWith(
        "unpaid-cancelled",
      );
    });

    it.each([
      ["ACTIVE", { status: "ACTIVE", paymentStatus: "PAID" }, "confirmed"],
      ["CANCELLED", { status: "CANCELLED", paymentStatus: "UNPAID" }, "cancelled"],
    ] as const)(
      "classifies an already settled %s extension as %s without calling the provider",
      async (_status, row, outcome) => {
        databaseService.extension.findFirst.mockResolvedValue(null);
        databaseService.extension.findUnique.mockResolvedValue(row);

        await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe(outcome);

        expect(flutterwaveService.findTransactionByReference).not.toHaveBeenCalled();
        expect(extensionReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
      },
    );

    it("does not query Flutterwave when an on-demand extension is not expired", async () => {
      databaseService.extension.findFirst.mockResolvedValue(null);
      databaseService.extension.findUnique.mockResolvedValue({
        status: "PENDING",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("retained");

      expect(flutterwaveService.findTransactionByReference).not.toHaveBeenCalled();
      expect(extensionReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
      expect(databaseService.extension.findUnique).toHaveBeenCalledWith({
        where: { id: "extension-1" },
        select: { status: true, paymentStatus: true },
      });
    });

    it.each([
      ["missing", null],
      ["paid but still pending", { status: "PENDING", paymentStatus: "PAID" }],
      ["unpaid but active", { status: "ACTIVE", paymentStatus: "UNPAID" }],
      ["paid and cancelled", { status: "CANCELLED", paymentStatus: "PAID" }],
      ["unpaid and pending", { status: "PENDING", paymentStatus: "UNPAID" }],
      ["refunded active", { status: "ACTIVE", paymentStatus: "REFUNDED" }],
    ] as const)("retains an extension in a %s state", async (_label, row) => {
      databaseService.extension.findFirst.mockResolvedValue(null);
      databaseService.extension.findUnique.mockResolvedValue(row);

      await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("retained");
    });

    it("retains an extension when a handled successful charge leaves the row pending", async () => {
      databaseService.extension.findFirst.mockResolvedValue({
        id: "extension-1",
        paymentIntent: "ext-idem-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue({
        ...transaction,
        tx_ref: "ext-idem-1",
      });
      databaseService.extension.findUnique.mockResolvedValue({
        status: "PENDING",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("retained");

      expect(chargeCompletedHandler.handle).toHaveBeenCalled();
      expect(extensionReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    });

    it("confirms an extension when a successful charge leaves it paid and active", async () => {
      databaseService.extension.findFirst.mockResolvedValue({
        id: "extension-1",
        paymentIntent: "ext-idem-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue({
        ...transaction,
        tx_ref: "ext-idem-1",
      });
      databaseService.extension.findUnique.mockResolvedValue({
        status: "ACTIVE",
        paymentStatus: "PAID",
      });

      await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("confirmed");

      expect(chargeCompletedHandler.handle).toHaveBeenCalled();
      expect(extensionReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    });

    it("classifies an extension cancellation attempt from the persisted row", async () => {
      databaseService.extension.findFirst.mockResolvedValue({
        id: "extension-1",
        paymentIntent: "ext-idem-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue(null);
      extensionReservationService.cancelExpiredReservation.mockResolvedValue(false);
      databaseService.extension.findUnique.mockResolvedValue({
        status: "CANCELLED",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("cancelled");

      expect(extensionReservationService.cancelExpiredReservation).toHaveBeenCalledWith(
        "extension-1",
      );
    });

    it("retains an extension when cancellation does not persist unpaid cancelled", async () => {
      databaseService.extension.findFirst.mockResolvedValue({
        id: "extension-1",
        paymentIntent: "ext-idem-1",
      });
      flutterwaveService.findTransactionByReference.mockResolvedValue(null);
      extensionReservationService.cancelExpiredReservation.mockResolvedValue(true);
      databaseService.extension.findUnique.mockResolvedValue({
        status: "PENDING",
        paymentStatus: "UNPAID",
      });

      await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe("retained");
    });

    it("counts confirmed and cancelled extensions and skips retained ones", async () => {
      databaseService.booking.findMany.mockResolvedValue([]);
      databaseService.extension.findMany.mockResolvedValue([
        { id: "ext-confirmed", paymentIntent: "ext-confirmed" },
        { id: "ext-cancelled", paymentIntent: "ext-cancelled" },
        { id: "ext-pending", paymentIntent: "ext-pending" },
        { id: "ext-provider-pending", paymentIntent: "ext-provider-pending" },
      ]);
      flutterwaveService.findTransactionByReference.mockImplementation(
        async (reference: string) => {
          if (reference === "ext-confirmed" || reference === "ext-pending") {
            return { ...transaction, tx_ref: reference };
          }
          if (reference === "ext-provider-pending") {
            return { ...transaction, tx_ref: reference, status: "pending" };
          }
          return null;
        },
      );
      databaseService.extension.findUnique.mockImplementation(
        async (args: { where: { id: string } }) => {
          if (args.where.id === "ext-confirmed") {
            return { status: "ACTIVE", paymentStatus: "PAID" };
          }
          if (args.where.id === "ext-cancelled") {
            return { status: "CANCELLED", paymentStatus: "UNPAID" };
          }
          return { status: "PENDING", paymentStatus: "UNPAID" };
        },
      );

      await expect(service.reconcileExpiredReservations()).resolves.toBe(2);

      expect(extensionReservationService.cancelExpiredReservation).toHaveBeenCalledTimes(1);
      expect(extensionReservationService.cancelExpiredReservation).toHaveBeenCalledWith(
        "ext-cancelled",
      );
      expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
    });
  });
});
