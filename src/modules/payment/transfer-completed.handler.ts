import { Injectable } from "@nestjs/common";
import { PayoutTransactionStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveTransferWebhookData } from "../flutterwave/flutterwave-webhook.schema";
import { PaymentService } from "./payment.service";

@Injectable()
export class TransferCompletedHandler {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentService: PaymentService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TransferCompletedHandler.name);
  }

  async handle(data: FlutterwaveTransferWebhookData): Promise<void> {
    const { reference, status, id: transferId } = data;

    this.logger.info(
      {
        reference,
        transferId,
        status,
      },
      "Processing transfer.completed webhook",
    );

    const payoutTransaction = await this.databaseService.payoutTransaction.findUnique({
      where: { payoutProviderReference: reference },
    });

    if (!payoutTransaction) {
      this.logger.warn({ reference }, "Payout transaction not found for webhook");
      return;
    }

    if (
      payoutTransaction.status === PayoutTransactionStatus.PAID_OUT ||
      payoutTransaction.status === PayoutTransactionStatus.FAILED
    ) {
      this.logger.info(
        {
          reference,
          currentStatus: payoutTransaction.status,
        },
        "Payout transaction already finalized, skipping",
      );
      return;
    }

    const result = await this.paymentService.reconcilePayout(payoutTransaction);
    if (!result?.reconciled) {
      this.logger.info(
        {
          reference,
          payoutTransactionId: payoutTransaction.id,
          providerStatus: result?.providerStatus,
          mismatchReason: result?.mismatchReason,
        },
        "Payout webhook did not produce a verified terminal transition",
      );
      return;
    }

    this.logger.info(
      {
        reference,
        payoutTransactionId: payoutTransaction.id,
        providerStatus: result.providerStatus,
      },
      "Payout transaction verified and finalized from webhook",
    );
  }
}
