import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPaymentRecord } from "../../shared/helper.fixtures";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { DatabaseService } from "../database/database.service";
import { BookingPaymentReconciliationService } from "./booking-payment-reconciliation.service";

describe("BookingPaymentReconciliationService", () => {
  let service: BookingPaymentReconciliationService;
  let databaseService: DatabaseService;
  let bookingConfirmationService: BookingConfirmationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPaymentReconciliationService,
        {
          provide: DatabaseService,
          useValue: {
            payment: {
              findMany: vi.fn(),
            },
          },
        },
        {
          provide: BookingConfirmationService,
          useValue: {
            confirmFromPayment: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(BookingPaymentReconciliationService);
    databaseService = module.get(DatabaseService);
    bookingConfirmationService = module.get(BookingConfirmationService);
  });

  it("retries eligible successful payments for pending bookings", async () => {
    const payment = createPaymentRecord({
      status: PaymentAttemptStatus.SUCCESSFUL,
      bookingId: "booking-1",
      amountExpected: new Decimal(10000),
      amountCharged: new Decimal(10000),
      currency: "NGN",
      confirmedAt: new Date("2026-07-27T12:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(bookingConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await expect(service.reconcilePendingBookings()).resolves.toBe(1);

    expect(databaseService.payment.findMany).toHaveBeenCalledWith({
      where: {
        status: PaymentAttemptStatus.SUCCESSFUL,
        bookingId: { not: null },
        confirmedAt: { lte: expect.any(Date) },
        booking: {
          is: {
            status: BookingStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            deletedAt: null,
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
      take: 50,
    });
    expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledWith(payment);
  });

  it.each([
    {
      reason: "missing charged amount",
      amountCharged: null,
      currency: "NGN",
    },
    {
      reason: "amount mismatch",
      amountCharged: new Decimal(9999),
      currency: "NGN",
    },
    {
      reason: "unsupported currency",
      amountCharged: new Decimal(10000),
      currency: "USD",
    },
  ])("skips $reason", async ({ amountCharged, currency }) => {
    const payment = createPaymentRecord({
      status: PaymentAttemptStatus.SUCCESSFUL,
      bookingId: "booking-1",
      amountExpected: new Decimal(10000),
      amountCharged,
      currency,
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);

    await expect(service.reconcilePendingBookings()).resolves.toBe(0);
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("continues reconciling after one booking fails", async () => {
    const first = createPaymentRecord({
      id: "payment-1",
      bookingId: "booking-1",
      status: PaymentAttemptStatus.SUCCESSFUL,
      amountCharged: new Decimal(10000),
    });
    const second = createPaymentRecord({
      id: "payment-2",
      bookingId: "booking-2",
      status: PaymentAttemptStatus.SUCCESSFUL,
      amountCharged: new Decimal(10000),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([first, second]);
    vi.mocked(bookingConfirmationService.confirmFromPayment)
      .mockRejectedValueOnce(new Error("outbox unavailable"))
      .mockResolvedValueOnce(true);

    await expect(service.reconcilePendingBookings()).resolves.toBe(1);
    expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledTimes(2);
  });

  it("returns zero when loading candidates fails", async () => {
    vi.mocked(databaseService.payment.findMany).mockRejectedValueOnce(new Error("database down"));

    await expect(service.reconcilePendingBookings()).resolves.toBe(0);
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });
});
