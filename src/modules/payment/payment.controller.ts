import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ZodBody } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import type {
  FlutterwaveWebhookPayload,
  PaymentIntentResponse,
  RefundResponse,
} from "../flutterwave/flutterwave.interface";
import { type InitializePaymentDto, initializePaymentSchema } from "./dto/initialize-payment.dto";
import { type RefundPaymentDto, refundPaymentSchema } from "./dto/refund-payment.dto";
import { FlutterwaveWebhookGuard } from "./guards/flutterwave-webhook.guard";
import type { PaymentStatusResponse } from "./payment.interface";
import { PaymentApiService } from "./payment-api.service";
import { PaymentWebhookService } from "./payment-webhook.service";

@Controller("api/payments")
export class PaymentController {
  constructor(
    private readonly paymentApiService: PaymentApiService,
    private readonly paymentWebhookService: PaymentWebhookService,
  ) {}

  /**
   * Initialize a payment for a booking or extension.
   * Returns a checkout URL that the client should redirect to.
   */
  @Post("initialize")
  @UseGuards(SessionGuard)
  async initializePayment(
    @ZodBody(initializePaymentSchema) dto: InitializePaymentDto,
    @CurrentUser() user: AuthSession["user"],
  ): Promise<PaymentIntentResponse> {
    return this.paymentApiService.initializePayment(dto, {
      id: user.id,
      email: user.email,
      name: user.name,
    });
  }

  /**
   * Get payment status by transaction reference.
   */
  @Get("status/:txRef")
  @UseGuards(SessionGuard)
  async getPaymentStatus(
    @Param("txRef") txRef: string,
    @CurrentUser() user: AuthSession["user"],
  ): Promise<PaymentStatusResponse> {
    return this.paymentApiService.getPaymentStatus(txRef, user.id);
  }

  /**
   * Initiate a refund for a payment.
   * Only the booking owner can request a refund (typically when cancelling).
   */
  @Post(":txRef/refund")
  @UseGuards(SessionGuard)
  async initiateRefund(
    @Param("txRef") txRef: string,
    @ZodBody(refundPaymentSchema) dto: RefundPaymentDto,
    @CurrentUser() user: AuthSession["user"],
  ): Promise<RefundResponse> {
    return this.paymentApiService.initiateRefund(txRef, dto, user.id);
  }

  /**
   * Handle Flutterwave webhook events.
   *
   * This endpoint receives webhook notifications from Flutterwave for:
   * - charge.completed: Payment successful
   * - transfer.completed: Payout transfer completed
   * - refund.completed: Refund processed
   *
   * The FlutterwaveWebhookGuard verifies the `verif-hash` header
   * to ensure the request is from Flutterwave.
   *
   * @see https://developer.flutterwave.com/v3.0/docs/webhooks
   */
  @Post("webhook/flutterwave")
  @UseGuards(FlutterwaveWebhookGuard)
  async handleFlutterwaveWebhook(
    @Body() payload: FlutterwaveWebhookPayload,
  ): Promise<{ status: string }> {
    await this.paymentWebhookService.handleWebhook(payload);

    // Always return 200 OK to acknowledge receipt
    return { status: "ok" };
  }
}
