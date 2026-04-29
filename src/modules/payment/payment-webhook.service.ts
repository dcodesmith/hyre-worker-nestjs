import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { FlutterwaveWebhookPayload } from "../flutterwave/flutterwave.interface";
import { ChargeCompletedHandler } from "./charge-completed.handler";
import { RefundCompletedHandler } from "./refund-completed.handler";
import { TransferCompletedHandler } from "./transfer-completed.handler";

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
  constructor(
    private readonly chargeCompletedHandler: ChargeCompletedHandler,
    private readonly transferCompletedHandler: TransferCompletedHandler,
    private readonly refundCompletedHandler: RefundCompletedHandler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentWebhookService.name);
  }

  /**
   * Main entry point for handling Flutterwave webhook events.
   *
   * Routes the payload to the appropriate handler based on event type.
   * The discriminated union ensures type-safe routing.
   */
  async handleWebhook(payload: FlutterwaveWebhookPayload): Promise<void> {
    this.logger.info({ event: payload.event }, "Processing Flutterwave webhook");

    switch (payload.event) {
      case "charge.completed":
        await this.chargeCompletedHandler.handle(payload.data);
        break;

      case "transfer.completed":
        await this.transferCompletedHandler.handle(payload.data);
        break;

      case "refund.completed":
        await this.refundCompletedHandler.handle(payload.data);
        break;

      default:
        this.logger.warn(
          {
            event: (payload as { event: string }).event,
          },
          "Received unknown webhook event",
        );
    }
  }
}
