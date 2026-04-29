import { Injectable } from "@nestjs/common";
import { PayoutTransactionStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveTransferWebhookData } from "../flutterwave/flutterwave.interface";

@Injectable()
export class TransferCompletedHandler {
  constructor(
    private readonly databaseService: DatabaseService,
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

    if (!reference) {
      this.logger.warn(
        "Missing reference in transfer.completed webhook, skipping to prevent data corruption",
      );
      return;
    }

    const payoutTransaction = await this.databaseService.payoutTransaction.findFirst({
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

    const normalizedStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
    if (!normalizedStatus) {
      this.logger.warn(
        {
          reference,
        },
        "Missing or invalid status in transfer.completed webhook, marking as failed",
      );
    }
    const newStatus =
      normalizedStatus === "SUCCESSFUL"
        ? PayoutTransactionStatus.PAID_OUT
        : PayoutTransactionStatus.FAILED;

    await this.databaseService.payoutTransaction.update({
      where: { id: payoutTransaction.id },
      data: {
        status: newStatus,
        completedAt: new Date(),
      },
    });

    this.logger.info(
      {
        reference,
        payoutTransactionId: payoutTransaction.id,
        newStatus,
      },
      "Payout transaction status updated from webhook",
    );
  }
}
