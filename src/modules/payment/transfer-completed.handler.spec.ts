import { Test, type TestingModule } from "@nestjs/testing";
import { PayoutTransactionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPayoutTransaction } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveTransferWebhookData } from "../flutterwave/flutterwave-webhook.schema";
import { PaymentService } from "./payment.service";
import { TransferCompletedHandler } from "./transfer-completed.handler";

describe("TransferCompletedHandler", () => {
  let handler: TransferCompletedHandler;
  let databaseService: DatabaseService;
  let paymentService: PaymentService;
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
              findUnique: vi.fn(),
            },
          },
        },
        {
          provide: PaymentService,
          useValue: {
            reconcilePayout: vi.fn().mockResolvedValue({
              reconciled: true,
              providerStatus: "SUCCESSFUL",
              mismatchReason: null,
            }),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    handler = module.get<TransferCompletedHandler>(TransferCompletedHandler);
    databaseService = module.get<DatabaseService>(DatabaseService);
    paymentService = module.get<PaymentService>(PaymentService);
    vi.clearAllMocks();
  });

  it("verifies the payout with Flutterwave before finalizing", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      payoutProviderReference: "payout-ref-123",
      status: PayoutTransactionStatus.PROCESSING,
    });
    vi.mocked(databaseService.payoutTransaction.findUnique).mockResolvedValueOnce(payout);

    await handler.handle(mockTransferData);

    expect(databaseService.payoutTransaction.findUnique).toHaveBeenCalledWith({
      where: { payoutProviderReference: mockTransferData.reference },
    });
    expect(paymentService.reconcilePayout).toHaveBeenCalledWith(payout);
  });

  it("does not trust a failed webhook as the terminal provider status", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      payoutProviderReference: "payout-ref-123",
      status: PayoutTransactionStatus.PROCESSING,
    });
    vi.mocked(databaseService.payoutTransaction.findUnique).mockResolvedValueOnce(payout);
    vi.mocked(paymentService.reconcilePayout).mockResolvedValueOnce({
      reconciled: false,
      providerStatus: "PENDING",
      mismatchReason: null,
    });

    await handler.handle({ ...mockTransferData, status: "FAILED" });

    expect(databaseService.payoutTransaction.findUnique).toHaveBeenCalledWith({
      where: { payoutProviderReference: mockTransferData.reference },
    });
    expect(paymentService.reconcilePayout).toHaveBeenCalledWith(payout);
  });

  it("skips update when payout already finalized", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      payoutProviderReference: "payout-ref-123",
      status: PayoutTransactionStatus.PAID_OUT,
    });
    vi.mocked(databaseService.payoutTransaction.findUnique).mockResolvedValueOnce(payout);

    await handler.handle(mockTransferData);

    expect(paymentService.reconcilePayout).not.toHaveBeenCalled();
  });
});
