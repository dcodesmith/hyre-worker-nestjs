import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import type { PaymentIntentResponse, RefundResponse } from "../flutterwave/flutterwave.interface";
import type { InitializePaymentDto } from "./dto/initialize-payment.dto";
import type { RefundPaymentDto } from "./dto/refund-payment.dto";

export interface PaymentStatusResponse {
  txRef: string;
  status: string;
  amountExpected: number;
  amountCharged: number | null;
  confirmedAt: Date | null;
  booking?: {
    id: string;
    status: string;
  };
  extension?: {
    id: string;
    status: string;
  };
}

export interface UserInfo {
  id: string;
  email: string;
  name: string | null;
}

@Injectable()
export class PaymentApiService {
  private readonly logger = new Logger(PaymentApiService.name);

  constructor(
    private readonly flutterwaveService: FlutterwaveService,
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * Initialize a payment for a booking or extension.
   */
  async initializePayment(
    dto: InitializePaymentDto,
    user: UserInfo,
  ): Promise<PaymentIntentResponse> {
    this.logger.log("Initializing payment", {
      type: dto.type,
      entityId: dto.entityId,
      userId: user.id,
    });

    // Validate entity belongs to user and is not already paid
    await this.validateEntityForPayment(dto.type, dto.entityId, user.id);

    // Create payment intent with Flutterwave
    const paymentIntent = await this.flutterwaveService.createPaymentIntent({
      amount: dto.amount,
      customer: {
        email: user.email,
        name: user.name || undefined,
      },
      callbackUrl: dto.callbackUrl,
      transactionType: dto.type === "booking" ? "booking_creation" : "booking_extension",
      idempotencyKey: `${dto.type}_${dto.entityId}`,
      metadata: {
        type: dto.type,
        entityId: dto.entityId,
        userId: user.id,
      },
    });

    this.logger.log("Payment intent created", {
      paymentIntentId: paymentIntent.paymentIntentId,
      type: dto.type,
      entityId: dto.entityId,
    });

    return paymentIntent;
  }

  /**
   * Get payment status by transaction reference.
   */
  async getPaymentStatus(txRef: string, userId: string): Promise<PaymentStatusResponse> {
    const payment = await this.databaseService.payment.findFirst({
      where: { txRef },
      include: {
        booking: { select: { id: true, status: true, userId: true } },
        extension: {
          select: {
            id: true,
            status: true,
            bookingLeg: { select: { booking: { select: { userId: true } } } },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    // Verify user owns this payment
    const ownerId = payment.booking?.userId || payment.extension?.bookingLeg.booking.userId;
    if (ownerId !== userId) {
      throw new BadRequestException("You do not have permission to view this payment");
    }

    return {
      txRef: payment.txRef,
      status: payment.status,
      amountExpected: payment.amountExpected.toNumber(),
      amountCharged: payment.amountCharged?.toNumber() ?? null,
      confirmedAt: payment.confirmedAt,
      booking: payment.booking
        ? { id: payment.booking.id, status: payment.booking.status }
        : undefined,
      extension: payment.extension
        ? { id: payment.extension.id, status: payment.extension.status }
        : undefined,
    };
  }

  /**
   * Initiate a refund for a payment.
   * Only the booking/extension owner can request a refund.
   */
  async initiateRefund(txRef: string, dto: RefundPaymentDto, userId: string): Promise<RefundResponse> {
    this.logger.log("Initiating refund", { txRef, amount: dto.amount, reason: dto.reason, userId });

    const payment = await this.databaseService.payment.findFirst({
      where: { txRef },
      include: {
        booking: { select: { userId: true } },
        extension: {
          select: {
            bookingLeg: { select: { booking: { select: { userId: true } } } },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    // Verify user owns this payment
    const ownerId = payment.booking?.userId || payment.extension?.bookingLeg.booking.userId;
    if (ownerId !== userId) {
      throw new BadRequestException("You do not have permission to refund this payment");
    }

    if (payment.status !== "SUCCESSFUL") {
      throw new BadRequestException("Cannot refund a payment that is not successful");
    }

    if (dto.amount > payment.amountExpected.toNumber()) {
      throw new BadRequestException("Refund amount cannot exceed payment amount");
    }

    if (!payment.flutterwaveTransactionId) {
      throw new BadRequestException("Payment does not have a provider reference");
    }

    const refundResult = await this.flutterwaveService.initiateRefund({
      transactionId: payment.flutterwaveTransactionId,
      amount: dto.amount,
      callbackUrl: this.flutterwaveService.getWebhookUrl("/api/payments/webhook/flutterwave"),
    });

    if (refundResult.success) {
      await this.databaseService.payment.update({
        where: { id: payment.id },
        data: {
          status: "REFUND_PROCESSING",
        },
      });

      this.logger.log("Refund initiated successfully", {
        txRef,
        refundId: refundResult.refundId,
      });
    }

    return refundResult;
  }

  /**
   * Validates that an entity exists, belongs to the user, and is not already paid.
   */
  private async validateEntityForPayment(
    type: "booking" | "extension",
    entityId: string,
    userId: string,
  ): Promise<void> {
    if (type === "booking") {
      const booking = await this.databaseService.booking.findUnique({
        where: { id: entityId },
        select: { id: true, userId: true, paymentStatus: true },
      });

      if (!booking) {
        throw new NotFoundException("Booking not found");
      }

      if (booking.userId !== userId) {
        throw new BadRequestException("You do not have permission to pay for this booking");
      }

      if (booking.paymentStatus === "PAID") {
        throw new BadRequestException("This booking has already been paid");
      }
    } else {
      const extension = await this.databaseService.extension.findUnique({
        where: { id: entityId },
        include: { bookingLeg: { select: { booking: { select: { userId: true } } } } },
      });

      if (!extension) {
        throw new NotFoundException("Extension not found");
      }

      if (extension.bookingLeg.booking.userId !== userId) {
        throw new BadRequestException("You do not have permission to pay for this extension");
      }

      if (extension.paymentStatus === "PAID") {
        throw new BadRequestException("This extension has already been paid");
      }
    }
  }
}
