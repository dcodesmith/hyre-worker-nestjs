import { Injectable } from "@nestjs/common";
import { PaymentAttemptStatus, PaymentStatus, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { GuestUserDetails } from "../../types";
import { DatabaseService } from "../database/database.service";
import { RefundStatusChangedHandler } from "../notification/handlers/refund-status-changed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { RefundDomainStateMismatchException } from "./payment.error";

const refundBookingSelect = {
  id: true,
  bookingReference: true,
  userId: true,
  guestUser: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
    },
  },
} satisfies Prisma.BookingSelect;

const refundPaymentInclude = {
  booking: {
    select: refundBookingSelect,
  },
  extension: {
    select: {
      bookingLeg: {
        select: {
          booking: {
            select: refundBookingSelect,
          },
        },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

export type RefundFinalizationPayment = Prisma.PaymentGetPayload<{
  include: typeof refundPaymentInclude;
}>;

type RefundNotificationBooking = Prisma.BookingGetPayload<{
  select: typeof refundBookingSelect;
}>;

export type TerminalRefundStatus =
  | typeof PaymentAttemptStatus.REFUNDED
  | typeof PaymentAttemptStatus.PARTIALLY_REFUNDED
  | typeof PaymentAttemptStatus.REFUND_FAILED;

export type FinalizeRefundInput = {
  paymentId: string;
  refundId: string;
  status: TerminalRefundStatus;
  amount: number;
  failureReason?: string;
  providerMetadata?: {
    status: string;
    flutterwaveReference: string;
  };
};

export type RequestRefundManualReviewInput = {
  paymentId: string;
  reason: string;
};

function toDomainPaymentStatus(status: TerminalRefundStatus): PaymentStatus {
  switch (status) {
    case PaymentAttemptStatus.REFUNDED:
      return PaymentStatus.REFUNDED;
    case PaymentAttemptStatus.PARTIALLY_REFUNDED:
      return PaymentStatus.PARTIALLY_REFUNDED;
    case PaymentAttemptStatus.REFUND_FAILED:
      return PaymentStatus.REFUND_FAILED;
  }
}

function getRefundNotificationCustomer(booking: RefundNotificationBooking) {
  const guestUser =
    booking.guestUser && typeof booking.guestUser === "object" && !Array.isArray(booking.guestUser)
      ? (booking.guestUser as GuestUserDetails)
      : null;

  return {
    userId: booking.userId ?? booking.user?.id ?? undefined,
    name: booking.user?.name ?? guestUser?.name,
    email: booking.user?.email ?? guestUser?.email,
    phoneNumber: booking.user?.phoneNumber ?? guestUser?.phoneNumber,
  };
}

@Injectable()
export class RefundFinalizationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly refundStatusChangedHandler: RefundStatusChangedHandler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RefundFinalizationService.name);
  }

  async finalize(input: FinalizeRefundInput): Promise<boolean> {
    const payment = await this.databaseService.payment.findUnique({
      where: { id: input.paymentId },
      include: refundPaymentInclude,
    });

    if (
      !payment ||
      (payment.status !== PaymentAttemptStatus.REFUND_PROCESSING &&
        payment.status !== PaymentAttemptStatus.REFUND_ERROR)
    ) {
      return false;
    }

    if (
      (!payment.bookingId && !payment.extensionId) ||
      (payment.bookingId && payment.extensionId)
    ) {
      return this.requestManualReview({
        paymentId: payment.id,
        reason:
          "Payment must reference exactly one booking or extension before refund finalization",
      });
    }

    const booking = payment.booking ?? payment.extension?.bookingLeg.booking;
    const existingWebhookPayload =
      payment.webhookPayload &&
      typeof payment.webhookPayload === "object" &&
      !Array.isArray(payment.webhookPayload)
        ? payment.webhookPayload
        : {};
    const webhookPayload = input.providerMetadata
      ? {
          ...existingWebhookPayload,
          refundAmount: input.amount,
          refundStatus: input.providerMetadata.status,
          refundFlwRef: input.providerMetadata.flutterwaveReference,
          refundedAt: new Date().toISOString(),
        }
      : undefined;

    let finalized: boolean;
    try {
      finalized = await this.databaseService.$transaction(async (tx) => {
        const result = await tx.payment.updateMany({
          where: {
            id: payment.id,
            status: {
              in: [PaymentAttemptStatus.REFUND_PROCESSING, PaymentAttemptStatus.REFUND_ERROR],
            },
          },
          data: {
            status: input.status,
            ...(webhookPayload ? { webhookPayload } : {}),
          },
        });

        if (result.count === 0) {
          return false;
        }

        const domainPaymentStatus = toDomainPaymentStatus(input.status);
        const currentDomainStatuses = [PaymentStatus.PAID, PaymentStatus.REFUND_PROCESSING];
        if (payment.bookingId) {
          const bookingUpdate = await tx.booking.updateMany({
            where: {
              id: payment.bookingId,
              paymentStatus: { in: currentDomainStatuses },
            },
            data: { paymentStatus: domainPaymentStatus },
          });
          if (bookingUpdate.count === 0) {
            throw new RefundDomainStateMismatchException(payment.id);
          }
        } else if (payment.extensionId) {
          const extensionUpdate = await tx.extension.updateMany({
            where: {
              id: payment.extensionId,
              paymentStatus: { in: currentDomainStatuses },
            },
            data: { paymentStatus: domainPaymentStatus },
          });
          if (extensionUpdate.count === 0) {
            throw new RefundDomainStateMismatchException(payment.id);
          }
        }

        if (booking) {
          await this.notificationOutboxService.create(
            this.refundStatusChangedHandler,
            {
              refundId: input.refundId,
              paymentId: payment.id,
              bookingId: booking.id,
              bookingReference: booking.bookingReference,
              status: input.status,
              amount: input.amount,
              failureReason: input.failureReason,
              customer: getRefundNotificationCustomer(booking),
            },
            tx,
          );
        }

        return true;
      });
    } catch (error) {
      if (error instanceof RefundDomainStateMismatchException) {
        return this.requestManualReview({
          paymentId: payment.id,
          reason:
            "Refund finalization could not update the related booking or extension payment status",
        });
      }
      throw error;
    }

    if (finalized && !booking) {
      this.logger.warn(
        { paymentId: payment.id, refundId: input.refundId },
        "Refund finalized without a related booking; notification was not created",
      );
    }

    return finalized;
  }

  async requestManualReview(input: RequestRefundManualReviewInput): Promise<boolean> {
    const payment = await this.databaseService.payment.findUnique({
      where: { id: input.paymentId },
      include: refundPaymentInclude,
    });
    if (
      !payment ||
      payment.refundManualReviewNotifiedAt ||
      (payment.status !== PaymentAttemptStatus.SUCCESSFUL &&
        payment.status !== PaymentAttemptStatus.REFUND_PROCESSING &&
        payment.status !== PaymentAttemptStatus.REFUND_ERROR)
    ) {
      return false;
    }

    const hasExactlyOneAssociation = Boolean(payment.bookingId) !== Boolean(payment.extensionId);
    const booking = hasExactlyOneAssociation
      ? (payment.booking ?? payment.extension?.bookingLeg.booking)
      : null;
    if (!booking) {
      this.logger.error(
        { paymentId: payment.id },
        "Requesting refund manual review without an unambiguous related booking",
      );
    }

    return this.databaseService.$transaction(async (tx) => {
      const result = await tx.payment.updateMany({
        where: {
          id: payment.id,
          refundManualReviewNotifiedAt: null,
          status: {
            in: [
              PaymentAttemptStatus.SUCCESSFUL,
              PaymentAttemptStatus.REFUND_PROCESSING,
              PaymentAttemptStatus.REFUND_ERROR,
            ],
          },
        },
        data: {
          refundManualReviewNotifiedAt: new Date(),
        },
      });
      if (result.count === 0) {
        return false;
      }

      await this.notificationOutboxService.create(
        this.refundStatusChangedHandler,
        {
          refundId: payment.refundProviderId ?? `unresolved:${payment.id}`,
          paymentId: payment.id,
          bookingId: booking?.id ?? `payment:${payment.id}`,
          bookingReference: booking?.bookingReference ?? `Payment ${payment.id}`,
          status: "REFUND_REVIEW_REQUIRED",
          amount: (payment.refundRequestedAmount ?? payment.amountCharged)?.toNumber() ?? 0,
          failureReason: input.reason,
          customer: booking ? getRefundNotificationCustomer(booking) : {},
        },
        tx,
      );

      return true;
    });
  }
}
