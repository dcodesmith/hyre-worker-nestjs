import { Injectable, Logger } from "@nestjs/common";
import { PaymentAttemptStatus, PayoutTransactionStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type {
  FlutterwaveChargeData,
  FlutterwaveRefundWebhookData,
  FlutterwaveTransferWebhookData,
  FlutterwaveWebhookPayload,
} from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";

/**
 * Service for handling Flutterwave webhook events.
 *
 * Processes payment events such as:
 * - charge.completed: Payment successful, activate booking/extension
 * - transfer.completed: Payout successful (handled by PaymentService)
 * - refund.completed: Refund processed, update payment status
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
  ) {}

  /**
   * Main entry point for handling Flutterwave webhook events.
   *
   * Routes the payload to the appropriate handler based on event type.
   * The discriminated union ensures type-safe routing.
   */
  async handleWebhook(payload: FlutterwaveWebhookPayload): Promise<void> {
    this.logger.log("Processing Flutterwave webhook", { event: payload.event });

    switch (payload.event) {
      case "charge.completed":
        await this.handleChargeCompleted(payload.data);
        break;

      case "transfer.completed":
        await this.handleTransferCompleted(payload.data);
        break;

      case "refund.completed":
        await this.handleRefundCompleted(payload.data);
        break;

      default:
        this.logger.warn("Received unknown webhook event", {
          event: (payload as { event: string }).event,
        });
    }
  }

  /**
   * Handle charge.completed webhook event.
   *
   * This is called when a customer successfully completes a payment.
   * It should:
   * 1. Verify the transaction with Flutterwave
   * 2. Update the Payment record status
   * 3. Activate the booking/extension (via BookingActivationService in future PR)
   */
  private async handleChargeCompleted(data: FlutterwaveChargeData): Promise<void> {
    const { tx_ref, id: transactionId, status, charged_amount } = data;

    this.logger.log("Processing charge.completed webhook", {
      txRef: tx_ref,
      transactionId,
      status,
      chargedAmount: charged_amount,
    });

    // Verify the transaction with Flutterwave to ensure webhook authenticity
    try {
      const verification = await this.flutterwaveService.verifyTransaction(
        transactionId.toString(),
      );

      if (verification.status !== "success") {
        this.logger.warn("Transaction verification failed", {
          txRef: tx_ref,
          transactionId,
          verificationStatus: verification.status,
        });
        return;
      }
    } catch (error) {
      this.logger.error("Failed to verify transaction", {
        txRef: tx_ref,
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Find and update the payment record
    const payment = await this.databaseService.payment.findFirst({
      where: { txRef: tx_ref },
    });

    if (!payment) {
      this.logger.warn("Payment not found for webhook", { txRef: tx_ref });
      return;
    }

    // Skip if already processed (idempotency)
    // Both SUCCESSFUL and FAILED are terminal states that should not be overwritten
    if (
      payment.status === PaymentAttemptStatus.SUCCESSFUL ||
      payment.status === PaymentAttemptStatus.FAILED
    ) {
      this.logger.log("Payment already finalized, skipping", {
        txRef: tx_ref,
        currentStatus: payment.status,
      });
      return;
    }

    // Update payment status
    await this.databaseService.payment.update({
      where: { id: payment.id },
      data: {
        status:
          status === "successful" ? PaymentAttemptStatus.SUCCESSFUL : PaymentAttemptStatus.FAILED,
        flutterwaveTransactionId: transactionId.toString(),
        amountCharged: charged_amount,
        confirmedAt: new Date(),
      },
    });

    this.logger.log("Payment status updated from webhook", {
      txRef: tx_ref,
      paymentId: payment.id,
      newStatus:
        status === "successful" ? PaymentAttemptStatus.SUCCESSFUL : PaymentAttemptStatus.FAILED,
    });

    // TODO: In PR 5 (Booking Activation), call BookingActivationService here
    // if (status === "successful") {
    //   await this.bookingActivationService.activateFromPayment(payment);
    // }
  }

  /**
   * Handle transfer.completed webhook event.
   *
   * This is called when a payout transfer is completed.
   * Delegates to PaymentService which handles payout state management.
   */
  private async handleTransferCompleted(data: FlutterwaveTransferWebhookData): Promise<void> {
    const { reference, status, id: transferId } = data;

    this.logger.log("Processing transfer.completed webhook", {
      reference,
      transferId,
      status,
    });

    // Find the payout transaction by the provider reference
    const payoutTransaction = await this.databaseService.payoutTransaction.findFirst({
      where: { payoutProviderReference: reference },
    });

    if (!payoutTransaction) {
      this.logger.warn("Payout transaction not found for webhook", { reference });
      return;
    }

    // Skip if already processed (idempotency)
    if (
      payoutTransaction.status === PayoutTransactionStatus.PAID_OUT ||
      payoutTransaction.status === PayoutTransactionStatus.FAILED
    ) {
      this.logger.log("Payout transaction already finalized, skipping", {
        reference,
        currentStatus: payoutTransaction.status,
      });
      return;
    }

    // Update payout transaction status
    // Flutterwave transfer status "SUCCESSFUL" maps to our "PAID_OUT"
    const newStatus =
      status === "successful" ? PayoutTransactionStatus.PAID_OUT : PayoutTransactionStatus.FAILED;
    await this.databaseService.payoutTransaction.update({
      where: { id: payoutTransaction.id },
      data: {
        status: newStatus,
        completedAt: new Date(),
      },
    });

    this.logger.log("Payout transaction status updated from webhook", {
      reference,
      payoutTransactionId: payoutTransaction.id,
      newStatus,
    });
  }

  /**
   * Handle refund.completed webhook event.
   *
   * This is called when a refund is processed.
   * It should update the Payment record with refund status.
   */
  private async handleRefundCompleted(data: FlutterwaveRefundWebhookData): Promise<void> {
    const { FlwRef, AmountRefunded, status, TransactionId } = data;

    this.logger.log("Processing refund.completed webhook", {
      flwRef: FlwRef,
      transactionId: TransactionId,
      amountRefunded: AmountRefunded,
      status,
    });

    // Find the payment by flutterwave transaction ID
    const payment = await this.databaseService.payment.findFirst({
      where: { flutterwaveTransactionId: TransactionId.toString() },
    });

    if (!payment) {
      this.logger.warn("Payment not found for refund webhook", {
        transactionId: TransactionId,
        flwRef: FlwRef,
      });
      return;
    }

    // Skip if not in a refund processing state (idempotency)
    if (payment.status !== PaymentAttemptStatus.REFUND_PROCESSING) {
      this.logger.log("Payment not in refund processing state, skipping", {
        paymentId: payment.id,
        currentStatus: payment.status,
      });
      return;
    }

    // Determine final refund status
    // If refunded amount equals charged amount, it's a full refund
    // Only consider it a full refund if we have a valid amountCharged to compare against
    const hasAmountCharged = payment.amountCharged != null;
    const amountCharged = hasAmountCharged ? payment.amountCharged.toNumber() : null;
    const isFullRefund = hasAmountCharged && AmountRefunded >= amountCharged;

    if (!hasAmountCharged) {
      this.logger.warn("Payment missing amountCharged, treating as partial refund", {
        paymentId: payment.id,
        amountRefunded: AmountRefunded,
      });
    }

    // Determine final refund status
    let newStatus: PaymentAttemptStatus;
    if (status !== "completed") {
      newStatus = PaymentAttemptStatus.REFUND_FAILED;
    } else if (isFullRefund) {
      newStatus = PaymentAttemptStatus.REFUNDED;
    } else {
      newStatus = PaymentAttemptStatus.PARTIALLY_REFUNDED;
    }

    await this.databaseService.payment.update({
      where: { id: payment.id },
      data: {
        status: newStatus,
        // Store refund info in webhookPayload since no dedicated columns exist
        webhookPayload: {
          refundAmount: AmountRefunded,
          refundStatus: status,
          refundFlwRef: FlwRef,
          refundedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.log("Payment refund status updated from webhook", {
      paymentId: payment.id,
      newStatus,
      amountRefunded: AmountRefunded,
      isFullRefund,
    });
  }
}
