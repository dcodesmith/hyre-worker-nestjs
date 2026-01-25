import { Injectable, Logger } from "@nestjs/common";
import type { Booking, Payment } from "@prisma/client";
import { BookingStatus, PaymentAttemptStatus, PayoutTransactionStatus } from "@prisma/client";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
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
    private readonly bookingConfirmationService: BookingConfirmationService,
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

    if (!this.validateChargeWebhookFields(tx_ref, transactionId)) {
      return;
    }

    try {
      await this.processVerifiedCharge(tx_ref, transactionId, charged_amount);
    } catch (error) {
      this.logger.error("Failed to verify transaction", {
        txRef: tx_ref,
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private validateChargeWebhookFields(
    txRef: string | undefined,
    transactionId: number | undefined,
  ): txRef is string {
    if (!txRef) {
      this.logger.warn(
        "Missing tx_ref in charge.completed webhook, skipping to prevent data corruption",
      );
      return false;
    }

    if (transactionId == null) {
      this.logger.warn(
        "Missing id in charge.completed webhook, skipping to prevent data corruption",
        { txRef },
      );
      return false;
    }

    return true;
  }

  private async processVerifiedCharge(
    txRef: string,
    transactionId: number,
    chargedAmount: number,
  ): Promise<void> {
    const verification = await this.flutterwaveService.verifyTransaction(transactionId.toString());

    const verificationData = this.validateVerification(
      verification,
      txRef,
      transactionId,
      chargedAmount,
    );
    if (!verificationData) {
      return;
    }

    const payment = await this.databaseService.payment.findFirst({
      where: { txRef },
      include: { booking: true },
    });

    if (!payment) {
      this.logger.warn("Payment not found for webhook", { txRef });
      return;
    }

    const newPaymentStatus =
      verificationData.status.toLowerCase() === "successful"
        ? PaymentAttemptStatus.SUCCESSFUL
        : PaymentAttemptStatus.FAILED;

    if (await this.handleIdempotencyOrRecovery(payment, txRef)) {
      return;
    }

    await this.updatePaymentFromCharge(
      payment.id,
      newPaymentStatus,
      transactionId,
      verificationData,
    );

    this.logger.log("Payment status updated from webhook", {
      txRef,
      paymentId: payment.id,
      newStatus: newPaymentStatus,
      verifiedStatus: verificationData.status,
    });

    if (newPaymentStatus === PaymentAttemptStatus.SUCCESSFUL) {
      await this.bookingConfirmationService.confirmFromPayment(payment);
    }
  }

  private validateVerification(
    verification: Awaited<ReturnType<typeof this.flutterwaveService.verifyTransaction>>,
    txRef: string,
    transactionId: number,
    chargedAmount: number,
  ): { status: string; charged_amount: number } | null {
    if (verification.status !== "success") {
      this.logger.warn("Transaction verification failed", {
        txRef,
        transactionId,
        verificationStatus: verification.status,
      });
      return null;
    }

    const data = verification.data;
    if (!data) {
      this.logger.warn("Transaction verification returned no data", { txRef, transactionId });
      return null;
    }

    if (data.tx_ref !== txRef) {
      this.logger.warn("Transaction verification tx_ref mismatch", {
        webhookTxRef: txRef,
        verifiedTxRef: data.tx_ref,
        transactionId,
      });
      return null;
    }

    if (data.id !== transactionId) {
      this.logger.warn("Transaction verification id mismatch", {
        webhookTransactionId: transactionId,
        verifiedTransactionId: data.id,
        txRef,
      });
      return null;
    }

    if (data.charged_amount !== chargedAmount) {
      this.logger.warn("Transaction verification charged_amount mismatch", {
        txRef,
        transactionId,
        webhookChargedAmount: chargedAmount,
        verifiedChargedAmount: data.charged_amount,
      });
      return null;
    }

    if (!data.status || typeof data.status !== "string") {
      this.logger.warn(
        "Missing or invalid status in transaction verification, skipping to prevent errors",
        { txRef, transactionId, status: data.status },
      );
      return null;
    }

    return { status: data.status, charged_amount: data.charged_amount };
  }

  /**
   * Handle idempotency check with recovery logic.
   * Returns true if processing should stop (already handled or recovered).
   */
  private async handleIdempotencyOrRecovery(
    payment: Payment & { booking: Booking | null },
    txRef: string,
  ): Promise<boolean> {
    if (payment.status === PaymentAttemptStatus.PENDING) {
      return false;
    }

    // Recovery case: Payment is SUCCESSFUL but booking is still PENDING
    if (
      payment.status === PaymentAttemptStatus.SUCCESSFUL &&
      payment.booking?.status === BookingStatus.PENDING
    ) {
      this.logger.log(
        "Payment already SUCCESSFUL but booking still PENDING, retrying confirmation for recovery",
        {
          txRef,
          paymentStatus: payment.status,
          bookingStatus: payment.booking.status,
          bookingId: payment.booking.id,
        },
      );
      await this.bookingConfirmationService.confirmFromPayment(payment);
      return true;
    }

    // Normal idempotency: skip duplicate processing
    this.logger.log("Payment already processed, skipping", {
      txRef,
      currentStatus: payment.status,
      bookingStatus: payment.booking?.status,
    });
    return true;
  }

  private async updatePaymentFromCharge(
    paymentId: string,
    status: PaymentAttemptStatus,
    transactionId: number,
    verificationData: { charged_amount: number },
  ): Promise<void> {
    await this.databaseService.payment.update({
      where: { id: paymentId },
      data: {
        status,
        flutterwaveTransactionId: transactionId.toString(),
        amountCharged: verificationData.charged_amount,
        confirmedAt: new Date(),
      },
    });
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

    // Validate required fields to prevent Prisma from matching any record
    // when undefined values cause where conditions to be ignored
    if (!reference) {
      this.logger.warn(
        "Missing reference in transfer.completed webhook, skipping to prevent data corruption",
      );
      return;
    }

    if (!status || typeof status !== "string") {
      this.logger.warn(
        "Missing or invalid status in transfer.completed webhook, skipping to prevent errors",
        { reference, status },
      );
      return;
    }

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
    // Flutterwave transfer status "SUCCESSFUL" (uppercase) maps to our "PAID_OUT"
    // Use case-insensitive comparison to handle potential API inconsistencies
    const newStatus =
      status.toUpperCase() === "SUCCESSFUL"
        ? PayoutTransactionStatus.PAID_OUT
        : PayoutTransactionStatus.FAILED;
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

    // Validate required fields to prevent Prisma from matching any record
    // when undefined values cause where conditions to be ignored
    if (!TransactionId) {
      this.logger.warn(
        "Missing TransactionId in refund.completed webhook, skipping to prevent data corruption",
      );
      return;
    }

    if (!status || typeof status !== "string") {
      this.logger.warn(
        "Missing or invalid status in refund.completed webhook, skipping to prevent errors",
        { transactionId: TransactionId, status },
      );
      return;
    }

    if (AmountRefunded == null || typeof AmountRefunded !== "number") {
      this.logger.warn(
        "Missing or invalid AmountRefunded in refund.completed webhook, skipping to prevent incorrect status determination",
        { transactionId: TransactionId, amountRefunded: AmountRefunded },
      );
      return;
    }

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
    // Flutterwave may send various "completed" variants like "completed", "completed-bank-transfer", "completed-momo"
    // Use case-insensitive prefix matching to handle all successful refund statuses
    const isRefundSuccessful = status.toLowerCase().startsWith("completed");

    let newStatus: PaymentAttemptStatus;
    if (!isRefundSuccessful) {
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
