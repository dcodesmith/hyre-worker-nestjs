import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PaymentStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type { PaymentIntentResponse, RefundResponse } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import type { InitializePaymentDto } from "./dto/initialize-payment.dto";
import type { RefundPaymentDto } from "./dto/refund-payment.dto";
import type { PaymentStatusResponse, UserInfo } from "./payment.interface";
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
    const ownerId = payment.booking?.userId || payment.extension?.bookingLeg?.booking?.userId;
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
      select: {
        id: true,
        status: true,
        amountCharged: true,
        flutterwaveTransactionId: true,
        refundIdempotencyKey: true,
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
    const ownerId = payment.booking?.userId || payment.extension?.bookingLeg?.booking?.userId;
    if (ownerId !== userId) {
      throw new BadRequestException("You do not have permission to refund this payment");
    }

    // Allow refunds for SUCCESSFUL payments or retrying REFUND_ERROR payments
    if (payment.status !== "SUCCESSFUL" && payment.status !== "REFUND_ERROR") {
      throw new BadRequestException(
        "Cannot refund a payment that is not successful or in refund error state",
      );
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

    // Generate idempotency key for this refund intent
    // Use existing key if retrying a REFUND_ERROR payment, otherwise generate new one
    const isRetry = payment.status === "REFUND_ERROR";
    const idempotencyKey =
      isRetry && payment.refundIdempotencyKey
        ? payment.refundIdempotencyKey
        : `refund_${payment.id}_${randomUUID()}`;

    // Reserve the refund and persist the idempotency key to prevent concurrent duplicate requests
    // CRITICAL: Match ONLY the status we observed when deciding the idempotency key strategy.
    // If we fetched SUCCESSFUL, only update if still SUCCESSFUL.
    // If we fetched REFUND_ERROR, only update if still REFUND_ERROR.
    // This prevents a race where Request A transitions SUCCESSFUL -> REFUND_ERROR (after a network error),
    // and Request B (which also fetched SUCCESSFUL) overwrites the idempotency key because REFUND_ERROR
    // would otherwise be an allowed starting status.
    const { count } = await this.databaseService.payment.updateMany({
      where: {
        id: payment.id,
        status: isRetry ? "REFUND_ERROR" : "SUCCESSFUL",
      },
      data: {
        status: "REFUND_PROCESSING",
        refundIdempotencyKey: idempotencyKey,
      },
    });

    if (count === 0) {
      throw new BadRequestException("Refund already in progress or payment status changed");
    }

    let refundResult: RefundResponse;

    try {
      refundResult = await this.flutterwaveService.initiateRefund({
        transactionId: payment.flutterwaveTransactionId,
        amount: dto.amount,
        callbackUrl: this.flutterwaveService.getWebhookUrl("/api/payments/webhook/flutterwave"),
        idempotencyKey,
      });
    } catch (error) {
      // Network error or unexpected failure - set to REFUND_ERROR instead of reverting to SUCCESSFUL
      // The idempotency key is preserved, so retries can safely use the same key
      // Rely on webhook/status reconciliation to finalize the payment state
      await this.databaseService.payment.update({
        where: { id: payment.id },
        data: { status: "REFUND_ERROR" },
      });

      this.logger.error("Refund request failed with error, status set to REFUND_ERROR", {
        txRef,
        paymentId: payment.id,
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
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
   * Booking statuses that should block payment initialization.
   * CANCELLED and REJECTED bookings cannot be paid for.
   */
  private static readonly UNPAYABLE_BOOKING_STATUSES = ["CANCELLED", "REJECTED"] as const;

  /**
   * Extension statuses that should block payment initialization.
   * CANCELLED and REJECTED extensions cannot be paid for.
   */
  private static readonly UNPAYABLE_EXTENSION_STATUSES = ["CANCELLED", "REJECTED"] as const;

  /**
   * Validates that an entity exists, belongs to the user, and is eligible for payment.
   * Returns the authoritative server-side amount for the entity.
   */
  private async validateEntityForPayment(
    type: "booking" | "extension",
    entityId: string,
    userId: string,
  ): Promise<number> {
    return type === "booking"
      ? this.validateBookingForPayment(entityId, userId)
      : this.validateExtensionForPayment(entityId, userId);
  }

  /**
   * Validates a booking exists, belongs to the user, and is eligible for payment.
   * Returns the authoritative server-side amount.
   */
  private async validateBookingForPayment(entityId: string, userId: string): Promise<number> {
    const booking = await this.databaseService.booking.findUnique({
      where: { id: entityId },
      select: { id: true, userId: true, status: true, paymentStatus: true, totalAmount: true },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    if (booking.userId !== userId) {
      throw new BadRequestException("You do not have permission to pay for this booking");
    }

    if (this.isUnpayableBookingStatus(booking.status)) {
      throw new BadRequestException(
        `Cannot pay for a booking with status: ${booking.status.toLowerCase()}`,
      );
    }

    if (booking.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException("This booking has already been paid");
    }

    return booking.totalAmount.toNumber();
  }

  /**
   * Validates an extension exists, belongs to the user, and is eligible for payment.
   * Returns the authoritative server-side amount.
   */
  private async validateExtensionForPayment(entityId: string, userId: string): Promise<number> {
    const extension = await this.databaseService.extension.findUnique({
      where: { id: entityId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        totalAmount: true,
        bookingLeg: { select: { booking: { select: { userId: true, status: true } } } },
      },
    });

    if (!extension) {
      throw new NotFoundException("Extension not found");
    }

    if (extension.bookingLeg.booking.userId !== userId) {
      throw new BadRequestException("You do not have permission to pay for this extension");
    }

    const parentBookingStatus = extension.bookingLeg.booking.status;
    if (this.isUnpayableBookingStatus(parentBookingStatus)) {
      throw new BadRequestException(
        `Cannot pay for extension: parent booking is ${parentBookingStatus.toLowerCase()}`,
      );
    }

    if (this.isUnpayableExtensionStatus(extension.status)) {
      throw new BadRequestException(
        `Cannot pay for an extension with status: ${extension.status.toLowerCase()}`,
      );
    }

    if (extension.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException("This extension has already been paid");
    }

    return extension.totalAmount.toNumber();
  }

  /**
   * Checks if a booking status blocks payment.
   */
  private isUnpayableBookingStatus(status: string): boolean {
    return PaymentApiService.UNPAYABLE_BOOKING_STATUSES.includes(
      status as (typeof PaymentApiService.UNPAYABLE_BOOKING_STATUSES)[number],
    );
  }

  /**
   * Checks if an extension status blocks payment.
   */
  private isUnpayableExtensionStatus(status: string): boolean {
    return PaymentApiService.UNPAYABLE_EXTENSION_STATUSES.includes(
      status as (typeof PaymentApiService.UNPAYABLE_EXTENSION_STATUSES)[number],
    );
  }
}
