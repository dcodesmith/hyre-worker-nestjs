import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { BookingReservationService } from "../booking/booking-reservation.service";
import { ExtensionReservationService } from "../booking/extension-reservation.service";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { BookingReservationExpirationService } from "./booking-reservation-expiration.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";

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
    booking: { findFirst: vi.fn(), findMany: vi.fn() },
    extension: { findFirst: vi.fn(), findMany: vi.fn() },
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

    await expect(service.reconcileExpiredReservations()).resolves.toBe(1);

    expect(chargeCompletedHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        tx_ref: "booking-1",
        status: "successful",
      }),
    );
    expect(bookingReservationService.cancelExpiredReservation).not.toHaveBeenCalled();
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
  });

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

    await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe(true);

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

    await expect(service.reconcileExpiredReservation("booking-1")).resolves.toBe(false);

    expect(flutterwaveService.findTransactionByReference).not.toHaveBeenCalled();
  });

  it("reconciles both deterministic references when the stored payment intent is missing", async () => {
    databaseService.booking.findMany.mockResolvedValue([{ id: "booking-1", paymentIntent: null }]);
    flutterwaveService.findTransactionByReference.mockResolvedValue(null);
    bookingReservationService.cancelExpiredReservation.mockResolvedValue(true);

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

    await expect(service.reconcileExpiredExtension("extension-1")).resolves.toBe(true);

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
});
