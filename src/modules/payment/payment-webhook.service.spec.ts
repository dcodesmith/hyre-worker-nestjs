import { Test, TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus, PayoutTransactionStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRecord, createPayoutTransaction } from "../../shared/helper.fixtures";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { DatabaseService } from "../database/database.service";
import type {
  FlutterwaveChargeData,
  FlutterwaveRefundWebhookData,
  FlutterwaveTransferWebhookData,
  FlutterwaveVerificationData,
} from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PaymentWebhookService } from "./payment-webhook.service";

const mockBookingConfirmationService = {
  confirmFromPayment: vi.fn(),
};

// Helper to create mock verification data matching webhook charge data
function createMockVerificationData(
  chargeData: FlutterwaveChargeData,
  overrides: Partial<FlutterwaveVerificationData> = {},
): FlutterwaveVerificationData {
  return {
    id: chargeData.id,
    tx_ref: chargeData.tx_ref,
    flw_ref: chargeData.flw_ref,
    device_fingerprint: chargeData.device_fingerprint,
    amount: chargeData.amount,
    currency: chargeData.currency,
    charged_amount: chargeData.charged_amount,
    app_fee: chargeData.app_fee,
    merchant_fee: chargeData.merchant_fee,
    processor_response: chargeData.processor_response,
    auth_model: chargeData.auth_model,
    ip: chargeData.ip,
    narration: chargeData.narration,
    status: chargeData.status,
    payment_type: chargeData.payment_type,
    created_at: chargeData.created_at,
    account_id: chargeData.account_id,
    customer: chargeData.customer,
    ...overrides,
  };
}

describe("PaymentWebhookService", () => {
  let service: PaymentWebhookService;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let bookingConfirmationService: BookingConfirmationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentWebhookService,
        {
          provide: DatabaseService,
          useValue: {
            payment: {
              findFirst: vi.fn(),
              update: vi.fn(),
            },
            payoutTransaction: {
              findFirst: vi.fn(),
              update: vi.fn(),
            },
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            verifyTransaction: vi.fn(),
          },
        },
        {
          provide: BookingConfirmationService,
          useValue: mockBookingConfirmationService,
        },
      ],
    }).compile();

    service = module.get<PaymentWebhookService>(PaymentWebhookService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);
    bookingConfirmationService = module.get<BookingConfirmationService>(BookingConfirmationService);

    // Reset mocks between tests
    vi.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("handleChargeCompleted", () => {
    const mockChargeData: FlutterwaveChargeData = {
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

    it("should update payment status to SUCCESSFUL when charge is successful", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.PENDING,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(flutterwaveService.verifyTransaction).toHaveBeenCalledWith("12345");
      expect(databaseService.payment.findFirst).toHaveBeenCalledWith({
        where: { txRef: "tx-ref-123" },
      });
      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: {
          status: "SUCCESSFUL",
          flutterwaveTransactionId: "12345",
          amountCharged: 10000,
          confirmedAt: expect.any(Date),
        },
      });
    });

    it("should call bookingConfirmationService when payment is successful", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.PENDING,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);
      vi.mocked(bookingConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledWith(mockPayment);
    });

    it("should not call bookingConfirmationService when payment fails", async () => {
      const failedChargeData = { ...mockChargeData, status: "failed" };
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.PENDING,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(failedChargeData, { status: "failed" }),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: failedChargeData });

      expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
    });

    it("should handle uppercase status from Flutterwave verification (case-insensitive)", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.PENDING,
      });

      // Flutterwave may return status in different cases (e.g., "SUCCESSFUL", "Successful")
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, { status: "SUCCESSFUL" }),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: expect.objectContaining({
          status: "SUCCESSFUL",
        }),
      });
    });

    it("should update payment status to FAILED when verified status is failed", async () => {
      const failedChargeData = { ...mockChargeData, status: "failed" };
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.PENDING,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(failedChargeData, { status: "failed" }),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: failedChargeData });

      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: expect.objectContaining({
          status: "FAILED",
        }),
      });
    });

    it("should skip processing if payment already successful (idempotency)", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing if payment already failed (idempotency)", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.FAILED,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it.each([
      PaymentAttemptStatus.REFUNDED,
      PaymentAttemptStatus.PARTIALLY_REFUNDED,
      PaymentAttemptStatus.REFUND_FAILED,
      PaymentAttemptStatus.REFUND_ERROR,
      PaymentAttemptStatus.REFUND_PROCESSING,
    ])(
      "should skip processing if payment is in %s state (idempotency - preserves refund states)",
      async (refundStatus) => {
        const mockPayment = createPaymentRecord({
          id: "payment-123",
          txRef: "tx-ref-123",
          status: refundStatus,
        });

        vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
          status: "success",
          message: "Transaction verified",
          data: createMockVerificationData(mockChargeData),
        });
        vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);

        await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

        expect(databaseService.payment.update).not.toHaveBeenCalled();
      },
    );

    it("should not update payment if verification fails", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "error",
        message: "Transaction not found",
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should not update payment if payment not found", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(null);

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should throw error if transaction verification throws", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockRejectedValueOnce(
        new Error("Network error"),
      );

      await expect(
        service.handleWebhook({ event: "charge.completed", data: mockChargeData }),
      ).rejects.toThrow("Network error");
    });

    it("should skip processing when tx_ref is undefined to prevent data corruption", async () => {
      const malformedData = { ...mockChargeData, tx_ref: undefined as unknown as string };

      await service.handleWebhook({ event: "charge.completed", data: malformedData });

      expect(flutterwaveService.verifyTransaction).not.toHaveBeenCalled();
      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when tx_ref is empty string to prevent data corruption", async () => {
      const malformedData = { ...mockChargeData, tx_ref: "" };

      await service.handleWebhook({ event: "charge.completed", data: malformedData });

      expect(flutterwaveService.verifyTransaction).not.toHaveBeenCalled();
      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when id is undefined to prevent TypeError", async () => {
      const malformedData = { ...mockChargeData, id: undefined as unknown as number };

      await service.handleWebhook({ event: "charge.completed", data: malformedData });

      expect(flutterwaveService.verifyTransaction).not.toHaveBeenCalled();
      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when id is null to prevent TypeError", async () => {
      const malformedData = { ...mockChargeData, id: null as unknown as number };

      await service.handleWebhook({ event: "charge.completed", data: malformedData });

      expect(flutterwaveService.verifyTransaction).not.toHaveBeenCalled();
      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when verification data is missing", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: undefined,
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when verification tx_ref does not match webhook", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, { tx_ref: "different-tx-ref" }),
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when verification transaction ID does not match webhook", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, { id: 99999 }),
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when verification charged_amount does not match webhook", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, { charged_amount: 99999 }),
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should use verified status (not webhook status) for payment state", async () => {
      // Webhook claims "successful" but verification shows "failed"
      const webhookWithWrongStatus = { ...mockChargeData, status: "successful" };
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.PENDING,
      });

      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(webhookWithWrongStatus, { status: "failed" }),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "charge.completed", data: webhookWithWrongStatus });

      // Should use verified status "failed", not webhook status "successful"
      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: expect.objectContaining({
          status: "FAILED",
        }),
      });
    });

    it("should skip processing when verification status is undefined to prevent TypeError", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, {
          status: undefined as unknown as string,
        }),
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when verification status is null to prevent TypeError", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, { status: null as unknown as string }),
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when verification status is not a string to prevent TypeError", async () => {
      vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
        status: "success",
        message: "Transaction verified",
        data: createMockVerificationData(mockChargeData, { status: 123 as unknown as string }),
      });

      await service.handleWebhook({ event: "charge.completed", data: mockChargeData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });
  });

  describe("handleTransferCompleted", () => {
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
      status: "SUCCESSFUL", // Flutterwave uses uppercase for transfer statuses
      reference: "payout-ref-123",
      meta: {},
      narration: "Payout for booking",
      complete_message: "Transfer completed",
      requires_approval: 0,
      is_approved: 1,
      bank_name: "Access Bank",
    };

    it("should update payout transaction status to PAID_OUT when transfer is successful", async () => {
      const mockPayout = createPayoutTransaction({
        id: "payout-123",
        payoutProviderReference: "payout-ref-123",
        status: PayoutTransactionStatus.PROCESSING,
      });

      vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(mockPayout);
      vi.mocked(databaseService.payoutTransaction.update).mockResolvedValueOnce(mockPayout);

      await service.handleWebhook({ event: "transfer.completed", data: mockTransferData });

      expect(databaseService.payoutTransaction.findFirst).toHaveBeenCalledWith({
        where: { payoutProviderReference: "payout-ref-123" },
      });
      expect(databaseService.payoutTransaction.update).toHaveBeenCalledWith({
        where: { id: "payout-123" },
        data: {
          status: "PAID_OUT",
          completedAt: expect.any(Date),
        },
      });
    });

    it("should update payout transaction status to FAILED when transfer fails", async () => {
      const failedTransferData = { ...mockTransferData, status: "FAILED" };
      const mockPayout = createPayoutTransaction({
        id: "payout-123",
        payoutProviderReference: "payout-ref-123",
        status: PayoutTransactionStatus.PROCESSING,
      });

      vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(mockPayout);
      vi.mocked(databaseService.payoutTransaction.update).mockResolvedValueOnce(mockPayout);

      await service.handleWebhook({ event: "transfer.completed", data: failedTransferData });

      expect(databaseService.payoutTransaction.update).toHaveBeenCalledWith({
        where: { id: "payout-123" },
        data: {
          status: "FAILED",
          completedAt: expect.any(Date),
        },
      });
    });

    it("should skip processing if payout already finalized (idempotency)", async () => {
      const mockPayout = createPayoutTransaction({
        id: "payout-123",
        payoutProviderReference: "payout-ref-123",
        status: PayoutTransactionStatus.PAID_OUT,
      });

      vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(mockPayout);

      await service.handleWebhook({ event: "transfer.completed", data: mockTransferData });

      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });

    it("should not update if payout transaction not found", async () => {
      vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(null);

      await service.handleWebhook({ event: "transfer.completed", data: mockTransferData });

      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });

    it("should skip processing when reference is undefined to prevent data corruption", async () => {
      const malformedData = { ...mockTransferData, reference: undefined as unknown as string };

      await service.handleWebhook({ event: "transfer.completed", data: malformedData });

      expect(databaseService.payoutTransaction.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });

    it("should skip processing when reference is empty string to prevent data corruption", async () => {
      const malformedData = { ...mockTransferData, reference: "" };

      await service.handleWebhook({ event: "transfer.completed", data: malformedData });

      expect(databaseService.payoutTransaction.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });

    it("should skip processing when status is undefined to prevent TypeError", async () => {
      const malformedData = { ...mockTransferData, status: undefined as unknown as string };

      await service.handleWebhook({ event: "transfer.completed", data: malformedData });

      expect(databaseService.payoutTransaction.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });

    it("should skip processing when status is null to prevent TypeError", async () => {
      const malformedData = { ...mockTransferData, status: null as unknown as string };

      await service.handleWebhook({ event: "transfer.completed", data: malformedData });

      expect(databaseService.payoutTransaction.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });

    it("should skip processing when status is not a string to prevent TypeError", async () => {
      const malformedData = { ...mockTransferData, status: 123 as unknown as string };

      await service.handleWebhook({ event: "transfer.completed", data: malformedData });

      expect(databaseService.payoutTransaction.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payoutTransaction.update).not.toHaveBeenCalled();
    });
  });

  describe("handleRefundCompleted", () => {
    const mockRefundData: FlutterwaveRefundWebhookData = {
      id: 11111,
      AmountRefunded: 10000,
      status: "completed",
      FlwRef: "FLW-REFUND-123",
      destination: "payment_source",
      comments: "Refund for cancelled booking",
      settlement_id: "NEW",
      meta: "{}",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      walletId: 12345,
      AccountId: 67890,
      TransactionId: 12345,
    };

    it("should update payment status to REFUNDED for full refund", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        flutterwaveTransactionId: "12345",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        amountCharged: new Decimal(10000),
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "refund.completed", data: mockRefundData });

      expect(databaseService.payment.findFirst).toHaveBeenCalledWith({
        where: { flutterwaveTransactionId: "12345" },
      });
      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: {
          status: "REFUNDED",
          webhookPayload: expect.objectContaining({
            refundAmount: 10000,
            refundStatus: "completed",
            refundFlwRef: "FLW-REFUND-123",
          }),
        },
      });
    });

    it("should update payment status to PARTIALLY_REFUNDED for partial refund", async () => {
      const partialRefundData = { ...mockRefundData, AmountRefunded: 5000 };
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        flutterwaveTransactionId: "12345",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        amountCharged: new Decimal(10000),
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "refund.completed", data: partialRefundData });

      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: expect.objectContaining({
          status: "PARTIALLY_REFUNDED",
        }),
      });
    });

    it("should update payment status to REFUND_FAILED when refund fails", async () => {
      const failedRefundData = { ...mockRefundData, status: "failed" };
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        flutterwaveTransactionId: "12345",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        amountCharged: new Decimal(10000),
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "refund.completed", data: failedRefundData });

      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: expect.objectContaining({
          status: "REFUND_FAILED",
        }),
      });
    });

    it("should skip processing if payment not in REFUND_PROCESSING state (idempotency)", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        flutterwaveTransactionId: "12345",
        status: PaymentAttemptStatus.REFUNDED,
        amountCharged: new Decimal(10000),
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "refund.completed", data: mockRefundData });

      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should not update if payment not found", async () => {
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(null);

      await service.handleWebhook({ event: "refund.completed", data: mockRefundData });

      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when TransactionId is undefined to prevent data corruption", async () => {
      const malformedData = { ...mockRefundData, TransactionId: undefined as unknown as number };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when TransactionId is null to prevent data corruption", async () => {
      const malformedData = { ...mockRefundData, TransactionId: null as unknown as number };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should treat as partial refund when amountCharged is null", async () => {
      const mockPayment = createPaymentRecord({
        id: "payment-123",
        flutterwaveTransactionId: "12345",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        amountCharged: null, // Missing amountCharged
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(mockPayment);
      vi.mocked(databaseService.payment.update).mockResolvedValueOnce(mockPayment);

      await service.handleWebhook({ event: "refund.completed", data: mockRefundData });

      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: expect.objectContaining({
          status: "PARTIALLY_REFUNDED",
        }),
      });
    });

    it("should skip processing when status is undefined to prevent TypeError", async () => {
      const malformedData = { ...mockRefundData, status: undefined as unknown as string };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when status is null to prevent TypeError", async () => {
      const malformedData = { ...mockRefundData, status: null as unknown as string };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when status is not a string to prevent TypeError", async () => {
      const malformedData = { ...mockRefundData, status: 123 as unknown as string };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when AmountRefunded is undefined to prevent incorrect status determination", async () => {
      const malformedData = { ...mockRefundData, AmountRefunded: undefined as unknown as number };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when AmountRefunded is null to prevent incorrect status determination", async () => {
      const malformedData = { ...mockRefundData, AmountRefunded: null as unknown as number };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });

    it("should skip processing when AmountRefunded is not a number to prevent incorrect status determination", async () => {
      const malformedData = { ...mockRefundData, AmountRefunded: "10000" as unknown as number };

      await service.handleWebhook({ event: "refund.completed", data: malformedData });

      expect(databaseService.payment.findFirst).not.toHaveBeenCalled();
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });
  });
});
