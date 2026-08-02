import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import {
  BOOKING_PAYMENT_SESSION_DURATION_MINUTES,
  BOOKING_PAYMENT_SESSION_DURATION_MS,
} from "../booking/booking.const";
import { DatabaseService } from "../database/database.service";
import type { PaymentIntentResponse, RefundResponse } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import type { InitializePaymentDto } from "./dto/initialize-payment.dto";
import type { RefundPaymentDto } from "./dto/refund-payment.dto";
import {
  PaymentAccessForbiddenException,
  PaymentAmountMismatchException,
  PaymentBookingNotFoundException,
  PaymentEntityAccessForbiddenException,
  PaymentEntityAlreadyPaidException,
  PaymentEntityNotPayableException,
  PaymentExtensionNotFoundException,
  PaymentNotFoundException,
  RefundAmountExceedsChargeException,
  RefundChargedAmountMissingException,
  RefundDomainStateMismatchException,
  RefundPaymentNotSuccessfulException,
  RefundProviderIdMissingException,
  RefundProviderReferenceMissingException,
  RefundReconciliationRequiredException,
  RefundReservationConflictException,
} from "./payment.error";
import type { PaymentStatusResponse, UserInfo } from "./payment.interface";
import { RefundFinalizationService } from "./refund-finalization.service";

@Injectable()
export class PaymentApiService {
  constructor(
    private readonly flutterwaveService: FlutterwaveService,
    private readonly databaseService: DatabaseService,
    private readonly refundFinalizationService: RefundFinalizationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentApiService.name);
  }

  /**
   * Initialize a payment for a booking or extension.
   */
  async initializePayment(
    dto: InitializePaymentDto,
    user: UserInfo,
  ): Promise<PaymentIntentResponse> {
    this.logger.info(
      {
        type: dto.type,
        entityId: dto.entityId,
        userId: user.id,
      },
      "Initializing payment",
    );

    // Validate entity and get server-side amount
    const serverAmount = await this.validateEntityForPayment(dto.type, dto.entityId, user.id);

    // Reject if client-supplied amount doesn't match server-side amount
    if (dto.amount !== serverAmount) {
      this.logger.warn(
        {
          clientAmount: dto.amount,
          serverAmount,
          type: dto.type,
          entityId: dto.entityId,
        },
        "Payment amount mismatch",
      );

      throw new PaymentAmountMismatchException(serverAmount, dto.amount);
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
      ...(dto.type === "booking" && {
        sessionDurationMinutes: BOOKING_PAYMENT_SESSION_DURATION_MINUTES,
      }),
    });

    if (dto.type === "booking") {
      await this.databaseService.booking.update({
        where: { id: dto.entityId },
        data: {
          paymentIntent: paymentIntent.paymentIntentId,
          paymentSessionExpiresAt: new Date(Date.now() + BOOKING_PAYMENT_SESSION_DURATION_MS),
        },
      });
    }

    this.logger.info(
      {
        paymentIntentId: paymentIntent.paymentIntentId,
        type: dto.type,
        entityId: dto.entityId,
      },
      "Payment intent created",
    );

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
      throw new PaymentNotFoundException(txRef);
    }

    // Verify user owns this payment
    const ownerId = payment.booking?.userId || payment.extension?.bookingLeg?.booking?.userId;
    if (ownerId !== userId) {
      throw new PaymentAccessForbiddenException(payment.id, "view");
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
    this.logger.info(
      { txRef, amount: dto.amount, reason: dto.reason, userId },
      "Initiating refund",
    );

    const payment = await this.fetchPaymentForRefund(txRef);
    this.validateRefundEligibility(payment, userId, dto.amount);

    const idempotencyKey = this.getRefundIdempotencyKey(payment);

    await this.reserveRefund(payment, dto.amount, idempotencyKey);

    // Safe: validateRefundEligibility ensures flutterwaveTransactionId exists
    const transactionId = payment.flutterwaveTransactionId;

    return this.executeRefund(txRef, payment.id, transactionId, dto.amount, idempotencyKey);
  }

  private async fetchPaymentForRefund(txRef: string) {
    const payment = await this.databaseService.payment.findFirst({
      where: { txRef },
      select: {
        id: true,
        bookingId: true,
        extensionId: true,
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
      throw new PaymentNotFoundException(txRef);
    }

    return payment;
  }

  private validateRefundEligibility(
    payment: Awaited<ReturnType<typeof this.fetchPaymentForRefund>>,
    userId: string,
    refundAmount: number,
  ): void {
    const ownerId = payment.booking?.userId || payment.extension?.bookingLeg?.booking?.userId;
    if (ownerId !== userId) {
      throw new PaymentAccessForbiddenException(payment.id, "refund");
    }

    if (payment.status === "REFUND_ERROR") {
      throw new RefundReconciliationRequiredException(payment.id);
    }

    if (payment.status !== "SUCCESSFUL") {
      throw new RefundPaymentNotSuccessfulException(payment.id, payment.status);
    }

    if (!payment.amountCharged) {
      throw new RefundChargedAmountMissingException(payment.id);
    }

    if (refundAmount > payment.amountCharged.toNumber()) {
      throw new RefundAmountExceedsChargeException(
        payment.id,
        refundAmount,
        payment.amountCharged.toNumber(),
      );
    }

    if (!payment.flutterwaveTransactionId) {
      throw new RefundProviderReferenceMissingException(payment.id);
    }
  }

  private getRefundIdempotencyKey(
    payment: Awaited<ReturnType<typeof this.fetchPaymentForRefund>>,
  ): string {
    return `refund_${payment.id}_${randomUUID()}`;
  }

  /**
   * Reserve the refund and persist the idempotency key to prevent concurrent duplicate requests.
   * CRITICAL: Match ONLY the status we observed when deciding the idempotency key strategy.
   */
  private async reserveRefund(
    payment: Awaited<ReturnType<typeof this.fetchPaymentForRefund>>,
    amount: number,
    idempotencyKey: string,
  ): Promise<void> {
    if (
      (!payment.bookingId && !payment.extensionId) ||
      (payment.bookingId && payment.extensionId)
    ) {
      throw new RefundDomainStateMismatchException(payment.id);
    }

    const reserved = await this.databaseService.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: "SUCCESSFUL",
        },
        data: {
          status: "REFUND_PROCESSING",
          refundIdempotencyKey: idempotencyKey,
          refundRequestedAmount: amount,
          refundRequestedAt: new Date(),
          refundReconciliationAttempts: 0,
          refundVerificationFailures: 0,
          refundManualReviewNotifiedAt: null,
        },
      });

      if (count === 0) {
        return false;
      }

      if (payment.bookingId) {
        const bookingUpdate = await tx.booking.updateMany({
          where: {
            id: payment.bookingId,
            paymentStatus: {
              in: [PaymentStatus.PAID, PaymentStatus.REFUND_PROCESSING],
            },
          },
          data: { paymentStatus: PaymentStatus.REFUND_PROCESSING },
        });

        if (bookingUpdate.count === 0) {
          throw new RefundDomainStateMismatchException(payment.id);
        }
      } else if (payment.extensionId) {
        const extensionUpdate = await tx.extension.updateMany({
          where: {
            id: payment.extensionId,
            paymentStatus: {
              in: [PaymentStatus.PAID, PaymentStatus.REFUND_PROCESSING],
            },
          },
          data: { paymentStatus: PaymentStatus.REFUND_PROCESSING },
        });

        if (extensionUpdate.count === 0) {
          throw new RefundDomainStateMismatchException(payment.id);
        }
      }

      return true;
    });

    if (!reserved) {
      throw new RefundReservationConflictException(payment.id);
    }
  }

  private async executeRefund(
    txRef: string,
    paymentId: string,
    transactionId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<RefundResponse> {
    let refundResult: RefundResponse;

    try {
      refundResult = await this.flutterwaveService.initiateRefund({
        transactionId,
        amount,
        callbackUrl: this.flutterwaveService.getWebhookUrl("/api/payments/webhook/flutterwave"),
        idempotencyKey,
      });
    } catch (error) {
      await this.markRefundUncertain(txRef, paymentId, idempotencyKey, error);
      throw error;
    }

    try {
      await this.handleRefundResult(txRef, paymentId, amount, idempotencyKey, refundResult);
    } catch (error) {
      await this.markRefundUncertain(txRef, paymentId, idempotencyKey, error, refundResult);
      throw error;
    }
    return refundResult;
  }

  private async markRefundUncertain(
    txRef: string,
    paymentId: string,
    idempotencyKey: string,
    error: unknown,
    refundResult?: RefundResponse,
  ): Promise<void> {
    const providerData =
      refundResult?.success && refundResult.refundId != null
        ? {
            refundProviderId: String(refundResult.refundId),
            refundProviderStatus: refundResult.status?.trim() || "unknown",
            refundLastCheckedAt: new Date(),
          }
        : {};

    await this.databaseService.payment.updateMany({
      where: {
        id: paymentId,
        status: "REFUND_PROCESSING",
      },
      data: {
        status: "REFUND_ERROR",
        ...providerData,
      },
    });

    this.logger.error(
      {
        txRef,
        paymentId,
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Refund outcome is uncertain and requires reconciliation",
    );
  }

  private async handleRefundResult(
    txRef: string,
    paymentId: string,
    amount: number,
    idempotencyKey: string,
    refundResult: RefundResponse,
  ): Promise<void> {
    if (refundResult.success) {
      if (refundResult.refundId == null) {
        throw new RefundProviderIdMissingException(paymentId);
      }

      const providerStatus = refundResult.status?.trim() || "unknown";
      await this.databaseService.payment.updateMany({
        where: {
          id: paymentId,
          status: "REFUND_PROCESSING",
        },
        data: {
          refundProviderId: String(refundResult.refundId),
          refundProviderStatus: providerStatus,
          refundLastCheckedAt: new Date(),
        },
      });

      this.logger.info(
        {
          txRef,
          refundId: refundResult.refundId,
        },
        "Refund initiated successfully",
      );
      return;
    }

    await this.refundFinalizationService.finalize({
      paymentId,
      refundId: `idempotency:${idempotencyKey}`,
      status: "REFUND_FAILED",
      amount,
      failureReason: refundResult.error || "Flutterwave rejected refund",
    });

    this.logger.warn(
      {
        txRef,
        error: refundResult.error,
      },
      "Refund request rejected by provider",
    );
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
      select: {
        id: true,
        userId: true,
        status: true,
        paymentStatus: true,
        totalAmount: true,
        paymentIntent: true,
        paymentSessionExpiresAt: true,
      },
    });

    if (!booking) {
      throw new PaymentBookingNotFoundException(entityId);
    }

    if (booking.userId !== userId) {
      throw new PaymentEntityAccessForbiddenException("booking", entityId);
    }

    if (this.isUnpayableBookingStatus(booking.status)) {
      throw new PaymentEntityNotPayableException(
        "booking",
        entityId,
        `status is ${booking.status.toLowerCase()}`,
      );
    }

    if (booking.paymentStatus === PaymentStatus.PAID) {
      throw new PaymentEntityAlreadyPaidException("booking", entityId);
    }

    if (booking.paymentStatus !== PaymentStatus.UNPAID) {
      throw new PaymentEntityNotPayableException(
        "booking",
        entityId,
        `payment status is ${booking.paymentStatus.toLowerCase()}`,
      );
    }
    if (booking.paymentSessionExpiresAt && booking.paymentSessionExpiresAt <= new Date()) {
      throw new PaymentEntityNotPayableException(
        "booking",
        entityId,
        "payment session has expired",
      );
    }
    if (booking.paymentIntent) {
      throw new PaymentEntityNotPayableException(
        "booking",
        entityId,
        "payment session is already initialized",
      );
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
      throw new PaymentExtensionNotFoundException(entityId);
    }

    if (extension.bookingLeg.booking.userId !== userId) {
      throw new PaymentEntityAccessForbiddenException("extension", entityId);
    }

    const parentBookingStatus = extension.bookingLeg.booking.status;
    if (this.isUnpayableBookingStatus(parentBookingStatus)) {
      throw new PaymentEntityNotPayableException(
        "extension",
        entityId,
        `parent booking is ${parentBookingStatus.toLowerCase()}`,
      );
    }

    if (this.isUnpayableExtensionStatus(extension.status)) {
      throw new PaymentEntityNotPayableException(
        "extension",
        entityId,
        `status is ${extension.status.toLowerCase()}`,
      );
    }

    if (extension.paymentStatus === PaymentStatus.PAID) {
      throw new PaymentEntityAlreadyPaidException("extension", entityId);
    }

    if (extension.paymentStatus !== PaymentStatus.UNPAID) {
      throw new PaymentEntityNotPayableException(
        "extension",
        entityId,
        `payment status is ${extension.paymentStatus.toLowerCase()}`,
      );
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
