import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPaymentRecord } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveFetchedRefundData } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RefundFinalizationService } from "./refund-finalization.service";
import { RefundReconciliationService } from "./refund-reconciliation.service";

function createFetchedRefund(
  overrides: Partial<FlutterwaveFetchedRefundData> = {},
): FlutterwaveFetchedRefundData {
  return {
    id: 123,
    amount_refunded: 10000,
    status: "completed",
    flw_ref: "FLW-REFUND-123",
    comment: null,
    settlement_id: "NEW",
    meta: {},
    created_at: "2026-07-30T19:00:00.000Z",
    account_id: 1,
    transaction_id: 456,
    ...overrides,
  };
}

describe("RefundReconciliationService", () => {
  let service: RefundReconciliationService;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let refundFinalizationService: RefundFinalizationService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T20:00:00.000Z"));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundReconciliationService,
        {
          provide: DatabaseService,
          useValue: {
            payment: {
              findMany: vi.fn(),
              findUnique: vi.fn(),
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            fetchRefund: vi.fn(),
          },
        },
        {
          provide: RefundFinalizationService,
          useValue: {
            finalize: vi.fn().mockResolvedValue(true),
            requestManualReview: vi.fn().mockResolvedValue(true),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(RefundReconciliationService);
    databaseService = module.get(DatabaseService);
    flutterwaveService = module.get(FlutterwaveService);
    refundFinalizationService = module.get(RefundFinalizationService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps Flutterwave completed status pending", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(createFetchedRefund());

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(0);

    expect(databaseService.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          refundManualReviewNotifiedAt: null,
        }),
      }),
    );
    expect(refundFinalizationService.finalize).not.toHaveBeenCalled();
    expect(refundFinalizationService.requestManualReview).not.toHaveBeenCalled();
  });

  it("finalizes a documented successful provider status", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(
      createFetchedRefund({ status: "completed-mpgs" }),
    );

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.finalize).toHaveBeenCalledWith({
      paymentId: "payment-123",
      refundId: "123",
      status: PaymentAttemptStatus.REFUNDED,
      amount: 10000,
      providerMetadata: {
        status: "completed-mpgs",
        flutterwaveReference: "FLW-REFUND-123",
      },
    });
  });

  it("finalizes a documented provider failure", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAmount: new Decimal(7500),
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(
      createFetchedRefund({
        amount_refunded: 0,
        status: "failed",
        comment: "Provider rejected refund",
      }),
    );

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PaymentAttemptStatus.REFUND_FAILED,
        amount: 7500,
        failureReason: "Provider rejected refund",
      }),
    );
  });

  it("hands off an uncertain refund that has no provider ID", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_ERROR,
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: expect.stringContaining("refund ID is unavailable"),
    });
    expect(flutterwaveService.fetchRefund).not.toHaveBeenCalled();
  });

  it("hands off a provider identity mismatch immediately", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(
      createFetchedRefund({ transaction_id: 999 }),
    );

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: "Flutterwave refund belongs to a different transaction",
    });
  });

  it("hands off when Flutterwave returns a different refund ID", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(
      createFetchedRefund({ id: 999 }),
    );

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: "Refund provider ID mismatch: expected 123, received 999",
    });
    expect(refundFinalizationService.finalize).not.toHaveBeenCalled();
  });

  it("hands off after three consecutive provider lookup failures", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
      refundVerificationFailures: 2,
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockRejectedValueOnce(new Error("timeout"));

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(0);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: "Flutterwave refund verification failed 3 consecutive times",
    });
  });

  it("hands off an unknown provider status after three consecutive checks", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
      refundVerificationFailures: 2,
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(
      createFetchedRefund({ status: "provider-review" }),
    );

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: 'Flutterwave returned unrecognized refund status "provider-review"',
    });
  });

  it("resets consecutive verification failures after a valid provider check", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
      refundVerificationFailures: 2,
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(createFetchedRefund());

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(0);

    expect(databaseService.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundVerificationFailures: 0,
        }),
      }),
    );
    expect(refundFinalizationService.requestManualReview).not.toHaveBeenCalled();
  });

  it("hands off a pending bank refund after its SLA", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      paymentMethod: "bank_transfer",
      refundProviderId: "123",
      refundRequestedAt: new Date("2026-07-28T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findMany).mockResolvedValueOnce([payment]);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(createFetchedRefund());

    await expect(service.reconcileProcessingRefunds()).resolves.toBe(1);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: expect.stringContaining("beyond the expected provider completion window"),
    });
  });

  it("persists a webhook refund ID before verifying provider state", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      flutterwaveTransactionId: "456",
      amountCharged: new Decimal(10000),
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findUnique).mockResolvedValueOnce(payment);
    vi.mocked(flutterwaveService.fetchRefund).mockResolvedValueOnce(createFetchedRefund());

    await expect(service.reconcileWebhookRefund("payment-123", "123")).resolves.toBe(false);

    expect(databaseService.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: "payment-123",
        refundProviderId: null,
        status: {
          in: [PaymentAttemptStatus.REFUND_PROCESSING, PaymentAttemptStatus.REFUND_ERROR],
        },
      },
      data: { refundProviderId: "123" },
    });
    expect(flutterwaveService.fetchRefund).toHaveBeenCalledWith("123");
  });

  it("hands off conflicting concurrent webhook refund IDs", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      refundRequestedAt: new Date("2026-07-30T19:00:00.000Z"),
    });
    vi.mocked(databaseService.payment.findUnique)
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, refundProviderId: "456" });
    vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 0 });

    await expect(service.reconcileWebhookRefund("payment-123", "123")).resolves.toBe(true);

    expect(refundFinalizationService.requestManualReview).toHaveBeenCalledWith({
      paymentId: "payment-123",
      reason: "Webhook refund ID 123 does not match persisted refund ID 456",
    });
    expect(flutterwaveService.fetchRefund).not.toHaveBeenCalled();
  });
});
