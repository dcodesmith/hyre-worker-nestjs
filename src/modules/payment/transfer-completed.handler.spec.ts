import { Test, type TestingModule } from "@nestjs/testing";
import { PayoutTransactionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayoutTransaction } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveTransferWebhookData } from "../flutterwave/flutterwave.interface";
import { TransferCompletedHandler } from "./transfer-completed.handler";

describe("TransferCompletedHandler", () => {
  let handler: TransferCompletedHandler;
  let databaseService: DatabaseService;

  const mockTransferData: FlutterwaveTransferWebhookData = {
    id: 67890,
    account_number: "1234567890",
    bank_code: "044",
    full_name: "Fleet Owner",
    created_at: "2024-01-01T00:00:00.000Z",
    currency: "NGN",
    debit_currency: "NGN",
    amount: 5000,
    fee: 50,
    status: "SUCCESSFUL",
    reference: "payout-ref-123",
    meta: {},
    narration: "Payout",
    complete_message: "Transfer completed",
    requires_approval: 0,
    is_approved: 1,
    bank_name: "Access Bank",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferCompletedHandler,
        {
          provide: DatabaseService,
          useValue: {
            payoutTransaction: {
              findFirst: vi.fn(),
              update: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    handler = module.get<TransferCompletedHandler>(TransferCompletedHandler);
    databaseService = module.get<DatabaseService>(DatabaseService);
    vi.clearAllMocks();
  });

  it("updates payout to PAID_OUT for successful transfer", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      payoutProviderReference: "payout-ref-123",
      status: PayoutTransactionStatus.PROCESSING,
    });
    vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(payout);

    await handler.handle(mockTransferData);

    expect(databaseService.payoutTransaction.findFirst).toHaveBeenCalledWith({
      where: { payoutProviderReference: mockTransferData.reference },
    });
    expect(databaseService.payoutTransaction.update).toHaveBeenCalledWith({
      where: { id: "payout-123" },
      data: { status: PayoutTransactionStatus.PAID_OUT, completedAt: expect.any(Date) },
    });
  });

  it("updates payout to FAILED for failed transfer", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      payoutProviderReference: "payout-ref-123",
      status: PayoutTransactionStatus.PROCESSING,
    });
    vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(payout);

    await handler.handle({ ...mockTransferData, status: "FAILED" });

    expect(databaseService.payoutTransaction.findFirst).toHaveBeenCalledWith({
      where: { payoutProviderReference: mockTransferData.reference },
    });
    expect(databaseService.payoutTransaction.update).toHaveBeenCalledWith({
      where: { id: "payout-123" },
      data: { status: PayoutTransactionStatus.FAILED, completedAt: expect.any(Date) },
    });
  });

  it("skips update when payout already finalized", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      payoutProviderReference: "payout-ref-123",
      status: PayoutTransactionStatus.PAID_OUT,
    });
    vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(payout);

    await handler.handle(mockTransferData);

    expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
  });

  it("skips processing when reference is missing", async () => {
    await handler.handle({ ...mockTransferData, reference: "" });

    expect(databaseService.payoutTransaction.findFirst).not.toHaveBeenCalled();
    expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
  });
});
