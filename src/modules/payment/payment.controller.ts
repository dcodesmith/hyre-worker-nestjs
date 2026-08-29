import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodBody } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import type { BookingPaymentStatusResponse } from "../booking/booking.interface";
import type { PaymentIntentResponse, RefundResponse } from "../flutterwave/flutterwave.interface";
import {
  type FlutterwaveWebhookPayload,
  flutterwaveWebhookPayloadSchema,
} from "../flutterwave/flutterwave-webhook.schema";
import {
  type ConfirmBookingPaymentDto,
  confirmBookingPaymentSchema,
} from "./dto/confirm-booking-payment.dto";
import {
  type ConfirmExtensionPaymentDto,
  confirmExtensionPaymentSchema,
} from "./dto/confirm-extension-payment.dto";
import { type InitializePaymentDto, initializePaymentSchema } from "./dto/initialize-payment.dto";
import {
  type ReconcileBookingExpirationDto,
  reconcileBookingExpirationSchema,
} from "./dto/reconcile-booking-expiration.dto";
import { type RefundPaymentDto, refundPaymentSchema } from "./dto/refund-payment.dto";
import { FlutterwaveWebhookGuard } from "./guards/flutterwave-webhook.guard";
import { InvalidFlutterwaveWebhookPayloadException } from "./payment.error";
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

  @Post("booking-confirmation")
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalSessionGuard)
  async confirmBookingPayment(
    @ZodBody(confirmBookingPaymentSchema) dto: ConfirmBookingPaymentDto,
    @CurrentUser() sessionUser: AuthSession["user"] | null,
    @Headers("x-payment-status-token") paymentStatusToken?: string,
  ): Promise<BookingPaymentStatusResponse> {
    return this.paymentApiService.confirmBookingPayment(dto, sessionUser, paymentStatusToken);
  }

  @Post("extension-confirmation")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async confirmExtensionPayment(
    @ZodBody(confirmExtensionPaymentSchema) dto: ConfirmExtensionPaymentDto,
    @CurrentUser() user: AuthSession["user"],
  ): Promise<PaymentStatusResponse> {
    return this.paymentApiService.confirmExtensionPayment(dto, user.id);
  }

  @Post("booking-expiration")
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalSessionGuard)
  async reconcileBookingExpiration(
    @ZodBody(reconcileBookingExpirationSchema) dto: ReconcileBookingExpirationDto,
    @CurrentUser() sessionUser: AuthSession["user"] | null,
    @Headers("x-payment-status-token") paymentStatusToken?: string,
  ): Promise<BookingPaymentStatusResponse> {
    return this.paymentApiService.reconcileBookingExpiration(dto, sessionUser, paymentStatusToken);
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
  @HttpCode(HttpStatus.OK)
  @UseGuards(FlutterwaveWebhookGuard)
  async handleFlutterwaveWebhook(
    @ZodBody(flutterwaveWebhookPayloadSchema, {
      exceptionFactory: (errors) => new InvalidFlutterwaveWebhookPayloadException(errors),
    })
    payload: FlutterwaveWebhookPayload,
  ): Promise<{ status: string }> {
    await this.paymentWebhookService.handleWebhook(payload);

    // Always return 200 OK to acknowledge receipt
    return { status: "ok" };
  }
}
