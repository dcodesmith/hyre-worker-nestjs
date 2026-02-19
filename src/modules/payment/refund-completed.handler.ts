import { Injectable, Logger } from "@nestjs/common";
import { PaymentAttemptStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveRefundWebhookData } from "../flutterwave/flutterwave.interface";

@Injectable()
export class RefundCompletedHandler {
  private readonly logger = new Logger(RefundCompletedHandler.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async handle(data: FlutterwaveRefundWebhookData): Promise<void> {
    const { FlwRef, AmountRefunded, status, TransactionId } = data;

    this.logger.log("Processing refund.completed webhook", {
      flwRef: FlwRef,
      transactionId: TransactionId,
      amountRefunded: AmountRefunded,
      status,
    });

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

    if (payment.status !== PaymentAttemptStatus.REFUND_PROCESSING) {
      this.logger.log("Payment not in refund processing state, skipping", {
        paymentId: payment.id,
        currentStatus: payment.status,
      });
      return;
    }

    const hasAmountCharged = payment.amountCharged != null;
    const amountCharged = hasAmountCharged ? payment.amountCharged.toNumber() : null;
    const isFullRefund = hasAmountCharged && AmountRefunded >= amountCharged;

    if (!hasAmountCharged) {
      this.logger.warn("Payment missing amountCharged, treating as partial refund", {
        paymentId: payment.id,
        amountRefunded: AmountRefunded,
      });
    }

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
