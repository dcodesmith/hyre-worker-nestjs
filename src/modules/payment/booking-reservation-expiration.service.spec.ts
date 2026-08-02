import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { BookingReservationService } from "../booking/booking-reservation.service";
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
    booking: { findMany: vi.fn() },
  };
  const flutterwaveService = {
    findTransactionByReference: vi.fn(),
  };
  const bookingReservationService = {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReservationExpirationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: FlutterwaveService, useValue: flutterwaveService },
        { provide: BookingReservationService, useValue: bookingReservationService },
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
});
