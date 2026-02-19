import { Injectable, Logger } from "@nestjs/common";
import { PayoutTransactionStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveTransferWebhookData } from "../flutterwave/flutterwave.interface";

@Injectable()
export class TransferCompletedHandler {
  private readonly logger = new Logger(TransferCompletedHandler.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async handle(data: FlutterwaveTransferWebhookData): Promise<void> {
    const { reference, status, id: transferId } = data;

    this.logger.log("Processing transfer.completed webhook", {
      reference,
      transferId,
      status,
    });

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
      this.logger.warn("Payout transaction not found for webhook", { reference });
      return;
    }

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
}
