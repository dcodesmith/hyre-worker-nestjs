import { Injectable } from "@nestjs/common";
import { PaymentAttemptStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveRefundWebhookData } from "../flutterwave/flutterwave.interface";

@Injectable()
export class RefundCompletedHandler {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RefundCompletedHandler.name);
  }

  async handle(data: FlutterwaveRefundWebhookData): Promise<void> {
    const { FlwRef, AmountRefunded, status, TransactionId } = data;

    this.logger.info(
      {
        flwRef: FlwRef,
        transactionId: TransactionId,
        amountRefunded: AmountRefunded,
        status,
      },
      "Processing refund.completed webhook",
    );

    if (!TransactionId) {
      this.logger.warn(
        "Missing TransactionId in refund.completed webhook, skipping to prevent data corruption",
      );
      return;
    }

    if (AmountRefunded == null || typeof AmountRefunded !== "number") {
      this.logger.warn(
        { transactionId: TransactionId, amountRefunded: AmountRefunded },
        "Missing or invalid AmountRefunded in refund.completed webhook, skipping to prevent incorrect status determination",
      );
      return;
    }

    const payment = await this.databaseService.payment.findFirst({
      where: { flutterwaveTransactionId: TransactionId.toString() },
    });

    if (!payment) {
      this.logger.warn(
        {
          transactionId: TransactionId,
          flwRef: FlwRef,
        },
        "Payment not found for refund webhook",
      );
      return;
    }

    if (payment.status !== PaymentAttemptStatus.REFUND_PROCESSING) {
      this.logger.info(
        {
          paymentId: payment.id,
          currentStatus: payment.status,
        },
        "Payment not in refund processing state, skipping",
      );
      return;
    }

    const hasAmountCharged = payment.amountCharged != null;
    const amountCharged = hasAmountCharged ? payment.amountCharged.toNumber() : null;
    const isFullRefund = hasAmountCharged && AmountRefunded >= amountCharged;

    if (!hasAmountCharged) {
      this.logger.warn(
        {
          paymentId: payment.id,
          amountRefunded: AmountRefunded,
        },
        "Payment missing amountCharged, treating as partial refund",
      );
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

    const existingWebhookPayload =
      payment.webhookPayload &&
      typeof payment.webhookPayload === "object" &&
      !Array.isArray(payment.webhookPayload)
        ? payment.webhookPayload
        : {};

    await this.databaseService.payment.update({
      where: { id: payment.id },
      data: {
        status: newStatus,
        webhookPayload: {
          ...existingWebhookPayload,
          refundAmount: AmountRefunded,
          refundStatus: status,
          refundFlwRef: FlwRef,
          refundedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.info(
      {
        paymentId: payment.id,
        newStatus,
        amountRefunded: AmountRefunded,
        isFullRefund,
      },
      "Payment refund status updated from webhook",
    );
  }
}
