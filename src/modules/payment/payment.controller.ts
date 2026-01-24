import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import type { PaymentIntentResponse, RefundResponse } from "../flutterwave/flutterwave.interface";
import { type InitializePaymentDto, initializePaymentSchema } from "./dto/initialize-payment.dto";
import { type RefundPaymentDto, refundPaymentSchema } from "./dto/refund-payment.dto";
import { ZodValidationPipe } from "./dto/zod-validation.pipe";
import { PaymentApiService, type PaymentStatusResponse } from "./payment-api.service";

@Controller("api/payments")
export class PaymentController {
  constructor(private readonly paymentApiService: PaymentApiService) {}

  /**
   * Initialize a payment for a booking or extension.
   * Returns a checkout URL that the client should redirect to.
   */
  @Post("initialize")
  @UseGuards(SessionGuard)
  async initializePayment(
    @Body(new ZodValidationPipe(initializePaymentSchema)) dto: InitializePaymentDto,
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
    @Body(new ZodValidationPipe(refundPaymentSchema)) dto: RefundPaymentDto,
    @CurrentUser() user: AuthSession["user"],
  ): Promise<RefundResponse> {
    return this.paymentApiService.initiateRefund(txRef, dto, user.id);
  }
}
