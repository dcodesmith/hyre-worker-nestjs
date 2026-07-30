import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveRefundWebhookData } from "../flutterwave/flutterwave-webhook.schema";
import { RefundWebhookPaymentNotFoundException } from "./payment.error";
import { RefundReconciliationService } from "./refund-reconciliation.service";

@Injectable()
export class RefundCompletedHandler {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly refundReconciliationService: RefundReconciliationService,
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

    const payment = await this.databaseService.payment.findUnique({
      where: { flutterwaveTransactionId: TransactionId.toString() },
      select: {
        id: true,
      },
    });

    if (!payment) {
      this.logger.warn(
        {
          transactionId: TransactionId,
          flwRef: FlwRef,
        },
        "Payment not found for refund webhook",
      );
      throw new RefundWebhookPaymentNotFoundException(TransactionId);
    }

    const refundId = String(data.id);
    const reconciled = await this.refundReconciliationService.reconcileWebhookRefund(
      payment.id,
      refundId,
    );

    if (!reconciled) {
      this.logger.info(
        { paymentId: payment.id, refundId, providerStatus: status },
        "Refund remains pending or was already reconciled",
      );
      return;
    }

    this.logger.info(
      {
        paymentId: payment.id,
        refundId,
        amountRefunded: AmountRefunded,
      },
      "Payment refund reconciled from webhook",
    );
  }
}
