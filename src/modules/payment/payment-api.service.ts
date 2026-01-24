import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { PaymentIntentResponse, RefundResponse } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
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

    // Validate entity and get server-side amount
    const serverAmount = await this.validateEntityForPayment(dto.type, dto.entityId, user.id);

    // Reject if client-supplied amount doesn't match server-side amount
    if (dto.amount !== serverAmount) {
      this.logger.warn("Payment amount mismatch", {
        clientAmount: dto.amount,
        serverAmount,
        type: dto.type,
        entityId: dto.entityId,
      });
      throw new BadRequestException(
        `Payment amount mismatch: expected ${serverAmount}, received ${dto.amount}`,
      );
    }

    // Create payment intent with Flutterwave using server-validated amount
    const paymentIntent = await this.flutterwaveService.createPaymentIntent({
      amount: serverAmount,
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
  async initiateRefund(
    txRef: string,
    dto: RefundPaymentDto,
    userId: string,
  ): Promise<RefundResponse> {
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

    // Validate refund amount against what was actually charged, not what was expected
    if (!payment.amountCharged) {
      throw new BadRequestException("Payment has no charged amount recorded");
    }

    if (dto.amount > payment.amountCharged.toNumber()) {
      throw new BadRequestException("Refund amount cannot exceed the amount charged");
    }

    if (!payment.flutterwaveTransactionId) {
      throw new BadRequestException("Payment does not have a provider reference");
    }

    // Reserve the refund to prevent concurrent duplicate requests
    const { count } = await this.databaseService.payment.updateMany({
      where: { id: payment.id, status: "SUCCESSFUL" },
      data: { status: "REFUND_PROCESSING" },
    });

    if (count === 0) {
      throw new BadRequestException("Refund already in progress");
    }

    let refundResult: RefundResponse;

    try {
      refundResult = await this.flutterwaveService.initiateRefund({
        transactionId: payment.flutterwaveTransactionId,
        amount: dto.amount,
        callbackUrl: this.flutterwaveService.getWebhookUrl("/api/payments/webhook/flutterwave"),
      });
    } catch (error) {
      // Network error or unexpected failure - revert to SUCCESSFUL since we don't know
      // if the refund request reached Flutterwave
      await this.databaseService.payment.update({
        where: { id: payment.id },
        data: { status: "SUCCESSFUL" },
      });
      throw error;
    }

    if (!refundResult.success) {
      // Flutterwave explicitly rejected the refund - mark as REFUND_FAILED
      await this.databaseService.payment.update({
        where: { id: payment.id },
        data: { status: "REFUND_FAILED" },
      });

      this.logger.warn("Refund request rejected by provider", {
        txRef,
        error: refundResult.error,
      });
    } else {
      // Refund initiated successfully - stays as REFUND_PROCESSING
      // Webhook will update to REFUND_PARTIAL or REFUND_FULL when complete
      this.logger.log("Refund initiated successfully", {
        txRef,
        refundId: refundResult.refundId,
      });
    }

    return refundResult;
  }

  /**
   * Validates that an entity exists, belongs to the user, and is not already paid.
   * Returns the authoritative server-side amount for the entity.
   */
  private async validateEntityForPayment(
    type: "booking" | "extension",
    entityId: string,
    userId: string,
  ): Promise<number> {
    if (type === "booking") {
      const booking = await this.databaseService.booking.findUnique({
        where: { id: entityId },
        select: { id: true, userId: true, paymentStatus: true, totalAmount: true },
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

      return booking.totalAmount.toNumber();
    } else {
      const extension = await this.databaseService.extension.findUnique({
        where: { id: entityId },
        select: {
          id: true,
          paymentStatus: true,
          totalAmount: true,
          bookingLeg: { select: { booking: { select: { userId: true } } } },
        },
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

      return extension.totalAmount.toNumber();
    }
  }
}
