import { Injectable, Logger } from "@nestjs/common";
import type { Booking, Payment, Prisma } from "@prisma/client";
import { PaymentAttemptStatus, PayoutTransactionStatus } from "@prisma/client";
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
      await this.processVerifiedCharge(data);
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

  private async processVerifiedCharge(data: FlutterwaveChargeData): Promise<void> {
    const { tx_ref: txRef, id: transactionId, charged_amount: chargedAmount } = data;

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

    const paymentStatus =
      verificationData.status?.toLowerCase() === "successful"
        ? PaymentAttemptStatus.SUCCESSFUL
        : PaymentAttemptStatus.FAILED;

    const payment = await this.findOrCreatePayment(data, paymentStatus);

    if (!payment) {
      this.logger.warn("Payment not found and could not be created for webhook", { txRef });
      return;
    }

    this.logger.log("Payment created from webhook", {
      txRef,
      paymentId: payment.id,
      status: paymentStatus,
      verifiedStatus: verificationData.status,
    });

    if (payment.status === PaymentAttemptStatus.SUCCESSFUL) {
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

    return { status: data.status, charged_amount: data.charged_amount };
  }

  /**
   * Find an existing Payment record for the charge, or create one if it doesn't exist.
   *
   * The Booking/Extension creation flow stores the Flutterwave payment intent ID
   * (tx_ref) on the entity but does not create a Payment record. The Payment record
   * is created here when the webhook arrives — matching the Remix app's
   * createOrUpdatePaymentRecord() pattern.
   */
  private async findOrCreatePayment(
    data: FlutterwaveChargeData,
    status: PaymentAttemptStatus,
  ): Promise<(Payment & { booking: Booking | null }) | null> {
    const {
      tx_ref: txRef,
      currency = "NGN",
      id: transactionId,
      payment_type: paymentMethod,
      flw_ref: flutterwaveReference,
      amount: webhookAmount,
      charged_amount: amountCharged,
    } = data;

    const booking = await this.databaseService.booking.findFirst({
      where: { paymentIntent: txRef },
      select: { id: true, totalAmount: true },
    });

    let bookingId: string | undefined;
    let extensionId: string | undefined;
    let amountExpected = webhookAmount;

    if (booking) {
      bookingId = booking.id;
      amountExpected = booking.totalAmount.toNumber() ?? amountExpected;
    } else {
      const extension = await this.databaseService.extension.findFirst({
        where: { paymentIntent: txRef },
        select: { id: true, totalAmount: true },
      });

      if (!extension) {
        this.logger.error("No booking or extension found for txRef, cannot create payment record", {
          txRef,
        });
        return null;
      }

      extensionId = extension.id;
      amountExpected = extension.totalAmount.toNumber() ?? amountExpected;
    }

    this.logger.log("Creating payment record from webhook", {
      txRef,
      bookingId,
      extensionId,
      amountExpected,
      amountCharged,
      status,
    });

    const created = await this.databaseService.payment.upsert({
      where: { txRef },
      update: {},
      create: {
        txRef,
        amountExpected,
        amountCharged,
        currency,
        status,
        flutterwaveTransactionId: String(transactionId),
        flutterwaveReference,
        paymentMethod,
        confirmedAt: new Date(),
        webhookPayload: data as unknown as Prisma.JsonObject,
        ...(bookingId && { bookingId }),
        ...(extensionId && { extensionId }),
      },
      include: { booking: true },
    });

    return created;
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
