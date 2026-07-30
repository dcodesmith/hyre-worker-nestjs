import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPaymentRecord } from "../../shared/helper.fixtures";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { ExtensionConfirmationService } from "../booking/extension-confirmation.service";
import { DatabaseService } from "../database/database.service";
import { PaymentService } from "./payment.service";
import { PaymentReconciliationService } from "./payment-reconciliation.service";

describe("PaymentReconciliationService", () => {
  let service: PaymentReconciliationService;
  let databaseService: DatabaseService;
  let bookingConfirmationService: BookingConfirmationService;
  let extensionConfirmationService: ExtensionConfirmationService;
  let paymentService: PaymentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentReconciliationService,
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
        {
          provide: ExtensionConfirmationService,
          useValue: {
            confirmFromPayment: vi.fn(),
          },
        },
        {
          provide: PaymentService,
          useValue: {
            reconcileProcessingPayouts: vi.fn(),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(PaymentReconciliationService);
    databaseService = module.get(DatabaseService);
    bookingConfirmationService = module.get(BookingConfirmationService);
    extensionConfirmationService = module.get(ExtensionConfirmationService);
    paymentService = module.get(PaymentService);
  });

  it("retries eligible successful payments for pending bookings", async () => {
    const payment = createPaymentRecord({
      status: PaymentAttemptStatus.SUCCESSFUL,
      bookingId: "booking-1",
      amountExpected: new Decimal(10000),
      amountCharged: new Decimal(10000),
      currency: "NGN",
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(bookingConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await expect(service.reconcilePendingPayments()).resolves.toBe(1);

    expect(databaseService.payment.findMany).toHaveBeenCalledWith({
      where: {
        status: PaymentAttemptStatus.SUCCESSFUL,
        confirmedAt: { lte: expect.any(Date) },
        OR: [
          {
            bookingId: { not: null },
            extensionId: null,
            booking: {
              is: {
                status: BookingStatus.PENDING,
                paymentStatus: PaymentStatus.UNPAID,
                deletedAt: null,
              },
            },
          },
          {
            bookingId: null,
            extensionId: { not: null },
            extension: {
              is: {
                status: "PENDING",
                paymentStatus: PaymentStatus.UNPAID,
                bookingLeg: {
                  booking: {
                    deletedAt: null,
                  },
                },
              },
            },
          },
        ],
      },
      orderBy: { confirmedAt: "asc" },
      take: 50,
    });
    expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledWith(payment);
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("retries eligible successful payments for pending extensions", async () => {
    const payment = createPaymentRecord({
      status: PaymentAttemptStatus.SUCCESSFUL,
      bookingId: null,
      extensionId: "extension-1",
      amountExpected: new Decimal(5000),
      amountCharged: new Decimal(5000),
      currency: "NGN",
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(extensionConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await expect(service.reconcilePendingPayments()).resolves.toBe(1);

    expect(extensionConfirmationService.confirmFromPayment).toHaveBeenCalledWith(payment);
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
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

    await expect(service.reconcilePendingPayments()).resolves.toBe(0);
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("continues reconciling after one payment fails", async () => {
    const bookingPayment = createPaymentRecord({
      id: "payment-1",
      bookingId: "booking-1",
      status: PaymentAttemptStatus.SUCCESSFUL,
      amountCharged: new Decimal(10000),
    });
    const extensionPayment = createPaymentRecord({
      id: "payment-2",
      bookingId: null,
      extensionId: "extension-2",
      status: PaymentAttemptStatus.SUCCESSFUL,
      amountCharged: new Decimal(10000),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([
      bookingPayment,
      extensionPayment,
    ]);
    vi.mocked(bookingConfirmationService.confirmFromPayment).mockRejectedValueOnce(
      new Error("outbox unavailable"),
    );
    vi.mocked(extensionConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await expect(service.reconcilePendingPayments()).resolves.toBe(1);
    expect(extensionConfirmationService.confirmFromPayment).toHaveBeenCalledWith(extensionPayment);
  });

  it("returns zero when loading candidates fails", async () => {
    vi.mocked(databaseService.payment.findMany).mockRejectedValueOnce(new Error("database down"));

    await expect(service.reconcilePendingPayments()).resolves.toBe(0);
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("reconciles stale processing payouts", async () => {
    vi.mocked(paymentService.reconcileProcessingPayouts).mockResolvedValueOnce(2);

    await expect(service.reconcileProcessingPayouts()).resolves.toBe(2);

    expect(paymentService.reconcileProcessingPayouts).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns zero when payout reconciliation fails", async () => {
    vi.mocked(paymentService.reconcileProcessingPayouts).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );

    await expect(service.reconcileProcessingPayouts()).resolves.toBe(0);
  });
});
