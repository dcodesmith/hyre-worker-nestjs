import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRecord } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveRefundWebhookData } from "../flutterwave/flutterwave.interface";
import { RefundCompletedHandler } from "./refund-completed.handler";

describe("RefundCompletedHandler", () => {
  let handler: RefundCompletedHandler;
  let databaseService: DatabaseService;

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
              findFirst: vi.fn(),
              update: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    handler = module.get<RefundCompletedHandler>(RefundCompletedHandler);
    databaseService = module.get<DatabaseService>(DatabaseService);
    vi.clearAllMocks();
  });

  it("marks payment as REFUNDED for full refund", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      flutterwaveTransactionId: "12345",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      amountCharged: new Decimal(10000),
    });
    vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

    await handler.handle(mockRefundData);

    expect(databaseService.payment.update).toHaveBeenCalledWith({
      where: { id: "payment-123" },
      data: expect.objectContaining({ status: "REFUNDED" }),
    });
  });

  it("marks payment as PARTIALLY_REFUNDED for partial refund", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      flutterwaveTransactionId: "12345",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      amountCharged: new Decimal(10000),
    });
    vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

    await handler.handle({ ...mockRefundData, AmountRefunded: 5000 });

    expect(databaseService.payment.update).toHaveBeenCalledWith({
      where: { id: "payment-123" },
      data: expect.objectContaining({ status: "PARTIALLY_REFUNDED" }),
    });
  });

  it("marks payment as REFUND_FAILED when webhook reports failed", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      flutterwaveTransactionId: "12345",
      status: PaymentAttemptStatus.REFUND_PROCESSING,
      amountCharged: new Decimal(10000),
    });
    vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

    await handler.handle({ ...mockRefundData, status: "failed" });

    expect(databaseService.payment.update).toHaveBeenCalledWith({
      where: { id: "payment-123" },
      data: expect.objectContaining({ status: "REFUND_FAILED" }),
    });
  });

  it("skips update when payment is not in REFUND_PROCESSING", async () => {
    const payment = createPaymentRecord({
      id: "payment-123",
      flutterwaveTransactionId: "12345",
      status: PaymentAttemptStatus.REFUNDED,
      amountCharged: new Decimal(10000),
    });
    vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

    await handler.handle(mockRefundData);

    expect(databaseService.payment.update).not.toHaveBeenCalled();
  });

  it("skips processing when AmountRefunded is invalid", async () => {
    await handler.handle({ ...mockRefundData, AmountRefunded: undefined as unknown as number });

    expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
    expect(databaseService.payment.update).not.toHaveBeenCalled();
  });
});
