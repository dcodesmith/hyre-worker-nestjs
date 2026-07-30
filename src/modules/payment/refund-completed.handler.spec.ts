import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPaymentRecord } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveRefundWebhookData } from "../flutterwave/flutterwave-webhook.schema";
import { RefundWebhookPaymentNotFoundException } from "./payment.error";
import { RefundCompletedHandler } from "./refund-completed.handler";
import { RefundReconciliationService } from "./refund-reconciliation.service";

describe("RefundCompletedHandler", () => {
  let handler: RefundCompletedHandler;
  let databaseService: DatabaseService;
  let refundReconciliationService: RefundReconciliationService;

  const mockRefundData: FlutterwaveRefundWebhookData = {
    id: 11111,
    AmountRefunded: 10000,
    status: "completed",
    FlwRef: "FLW-REFUND-123",
    destination: "payment_source",
    comments: "Refund",
    settlement_id: "NEW",
    meta: "{}",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    walletId: 12345,
    AccountId: 67890,
    TransactionId: 12345,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundCompletedHandler,
        {
          provide: DatabaseService,
          useValue: {
            payment: {
              findUnique: vi.fn(),
            },
          },
        },
        {
          provide: RefundReconciliationService,
          useValue: {
            reconcileWebhookRefund: vi.fn().mockResolvedValue(true),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    handler = module.get(RefundCompletedHandler);
    databaseService = module.get(DatabaseService);
    refundReconciliationService = module.get(RefundReconciliationService);
  });

  it("re-queries Flutterwave before applying a refund webhook", async () => {
    vi.mocked(databaseService.payment.findUnique).mockResolvedValueOnce(
      createPaymentRecord({
        id: "payment-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
      }),
    );

    await handler.handle(mockRefundData);

    expect(refundReconciliationService.reconcileWebhookRefund).toHaveBeenCalledWith(
      "payment-123",
      "11111",
    );
  });

  it("accepts a webhook after an uncertain refund request", async () => {
    vi.mocked(databaseService.payment.findUnique).mockResolvedValueOnce(
      createPaymentRecord({
        id: "payment-123",
        status: PaymentAttemptStatus.REFUND_ERROR,
      }),
    );

    await handler.handle(mockRefundData);

    expect(refundReconciliationService.reconcileWebhookRefund).toHaveBeenCalledWith(
      "payment-123",
      "11111",
    );
  });

  it("delegates duplicate detection to reconciliation", async () => {
    vi.mocked(databaseService.payment.findUnique).mockResolvedValueOnce(
      createPaymentRecord({
        id: "payment-123",
        status: PaymentAttemptStatus.REFUNDED,
      }),
    );

    await handler.handle(mockRefundData);

    expect(refundReconciliationService.reconcileWebhookRefund).toHaveBeenCalledWith(
      "payment-123",
      "11111",
    );
  });

  it("rejects unknown payments so Flutterwave can retry delivery", async () => {
    vi.mocked(databaseService.payment.findUnique).mockResolvedValueOnce(null);

    await expect(handler.handle(mockRefundData)).rejects.toThrow(
      RefundWebhookPaymentNotFoundException,
    );

    expect(refundReconciliationService.reconcileWebhookRefund).not.toHaveBeenCalled();
  });
});
