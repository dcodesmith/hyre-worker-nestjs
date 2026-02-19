import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FlutterwaveChargeData,
  FlutterwaveRefundWebhookData,
  FlutterwaveTransferWebhookData,
} from "../flutterwave/flutterwave.interface";
import { ChargeCompletedHandler } from "./charge-completed.handler";
import { PaymentWebhookService } from "./payment-webhook.service";
import { RefundCompletedHandler } from "./refund-completed.handler";
import { TransferCompletedHandler } from "./transfer-completed.handler";

describe("PaymentWebhookService", () => {
  let service: PaymentWebhookService;
  const chargeCompletedHandler = { handle: vi.fn() };
  const transferCompletedHandler = { handle: vi.fn() };
  const refundCompletedHandler = { handle: vi.fn() };

  const chargeData: FlutterwaveChargeData = {
    id: 12345,
    tx_ref: "tx-ref-123",
    flw_ref: "FLW-REF-123",
    device_fingerprint: "fingerprint",
    amount: 10000,
    currency: "NGN",
    charged_amount: 10000,
    app_fee: 100,
    merchant_fee: 0,
    processor_response: "Approved",
    auth_model: "PIN",
    ip: "127.0.0.1",
    narration: "Payment",
    status: "successful",
    payment_type: "card",
    created_at: "2024-01-01T00:00:00.000Z",
    account_id: 1,
    customer: {
      id: 1,
      name: "Test User",
      phone_number: null,
      email: "test@example.com",
      created_at: "2024-01-01T00:00:00.000Z",
    },
  };

  const transferData: FlutterwaveTransferWebhookData = {
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

  const refundData: FlutterwaveRefundWebhookData = {
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
        PaymentWebhookService,
        { provide: ChargeCompletedHandler, useValue: chargeCompletedHandler },
        { provide: TransferCompletedHandler, useValue: transferCompletedHandler },
        { provide: RefundCompletedHandler, useValue: refundCompletedHandler },
      ],
    }).compile();

    service = module.get<PaymentWebhookService>(PaymentWebhookService);
    vi.clearAllMocks();
  });

  it("routes charge.completed to ChargeCompletedHandler", async () => {
    await service.handleWebhook({ event: "charge.completed", data: chargeData });

    expect(chargeCompletedHandler.handle).toHaveBeenCalledWith(chargeData);
    expect(transferCompletedHandler.handle).not.toHaveBeenCalled();
    expect(refundCompletedHandler.handle).not.toHaveBeenCalled();
  });

  it("routes transfer.completed to TransferCompletedHandler", async () => {
    await service.handleWebhook({ event: "transfer.completed", data: transferData });

    expect(transferCompletedHandler.handle).toHaveBeenCalledWith(transferData);
    expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
    expect(refundCompletedHandler.handle).not.toHaveBeenCalled();
  });

  it("routes refund.completed to RefundCompletedHandler", async () => {
    await service.handleWebhook({ event: "refund.completed", data: refundData });

    expect(refundCompletedHandler.handle).toHaveBeenCalledWith(refundData);
    expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
    expect(transferCompletedHandler.handle).not.toHaveBeenCalled();
  });

  it("ignores unknown events without calling handlers", async () => {
    await service.handleWebhook({
      event: "something.unknown",
      data: {} as FlutterwaveChargeData,
    } as never);

    expect(chargeCompletedHandler.handle).not.toHaveBeenCalled();
    expect(transferCompletedHandler.handle).not.toHaveBeenCalled();
    expect(refundCompletedHandler.handle).not.toHaveBeenCalled();
  });
});
