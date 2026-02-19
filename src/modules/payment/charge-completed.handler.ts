import { Injectable, Logger } from "@nestjs/common";
import type { Booking, Payment, Prisma } from "@prisma/client";
import { PaymentAttemptStatus } from "@prisma/client";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { ExtensionConfirmationService } from "../booking/extension-confirmation.service";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveChargeData } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";

@Injectable()
export class ChargeCompletedHandler {
  private readonly logger = new Logger(ChargeCompletedHandler.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly bookingConfirmationService: BookingConfirmationService,
    private readonly extensionConfirmationService: ExtensionConfirmationService,
  ) {}

  async handle(data: FlutterwaveChargeData): Promise<void> {
    const { tx_ref, id: transactionId, status, charged_amount } = data;

    this.logger.log("Processing charge.completed webhook", {
      txRef: tx_ref,
      transactionId,
      status,
      chargedAmount: charged_amount,
    });

    if (!this.validateChargeWebhookFields(tx_ref, transactionId)) {
      return;
    }

    try {
      await this.processVerifiedCharge(data);
    } catch (error) {
      this.logger.error("Failed to verify transaction", {
        txRef: tx_ref,
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private validateChargeWebhookFields(
    txRef: string | undefined,
    transactionId: number | undefined,
  ): txRef is string {
    if (!txRef) {
      this.logger.warn(
        "Missing tx_ref in charge.completed webhook, skipping to prevent data corruption",
      );
      return false;
    }

    if (transactionId == null) {
      this.logger.warn(
        "Missing id in charge.completed webhook, skipping to prevent data corruption",
        { txRef },
      );
      return false;
    }

    return true;
  }

  private async processVerifiedCharge(data: FlutterwaveChargeData): Promise<void> {
    const { tx_ref: txRef, id: transactionId, charged_amount: chargedAmount } = data;

    const verification = await this.flutterwaveService.verifyTransaction(transactionId.toString());
    const verificationData = this.validateVerification(
      verification,
      txRef,
      transactionId,
      chargedAmount,
    );
    if (!verificationData) {
      return;
    }

    const paymentStatus =
      verificationData.status?.toLowerCase() === "successful"
        ? PaymentAttemptStatus.SUCCESSFUL
        : PaymentAttemptStatus.FAILED;

    const payment = await this.findOrCreatePayment(data, paymentStatus);
    if (!payment) {
      this.logger.warn("Payment not found and could not be created for webhook", { txRef });
      return;
    }

    this.logger.log("Payment created from webhook", {
      txRef,
      paymentId: payment.id,
      status: paymentStatus,
      verifiedStatus: verificationData.status,
    });

    if (payment.status !== PaymentAttemptStatus.SUCCESSFUL) {
      return;
    }

    if (payment.bookingId) {
      await this.bookingConfirmationService.confirmFromPayment(payment);
      return;
    }

    if (payment.extensionId) {
      await this.extensionConfirmationService.confirmFromPayment(payment);
    }
  }

  private validateVerification(
    verification: Awaited<ReturnType<typeof this.flutterwaveService.verifyTransaction>>,
    txRef: string,
    transactionId: number,
    chargedAmount: number,
  ): { status: string; charged_amount: number } | null {
    if (verification.status !== "success") {
      this.logger.warn("Transaction verification failed", {
        txRef,
        transactionId,
        verificationStatus: verification.status,
      });
      return null;
    }

    const data = verification.data;
    if (!data) {
      this.logger.warn("Transaction verification returned no data", { txRef, transactionId });
      return null;
    }

    if (data.tx_ref !== txRef) {
      this.logger.warn("Transaction verification tx_ref mismatch", {
        webhookTxRef: txRef,
        verifiedTxRef: data.tx_ref,
        transactionId,
      });
      return null;
    }

    if (data.id !== transactionId) {
      this.logger.warn("Transaction verification id mismatch", {
        webhookTransactionId: transactionId,
        verifiedTransactionId: data.id,
        txRef,
      });
      return null;
    }

    if (data.charged_amount !== chargedAmount) {
      this.logger.warn("Transaction verification charged_amount mismatch", {
        txRef,
        transactionId,
        webhookChargedAmount: chargedAmount,
        verifiedChargedAmount: data.charged_amount,
      });
      return null;
    }

    return { status: data.status, charged_amount: data.charged_amount };
  }

  private async findOrCreatePayment(
    data: FlutterwaveChargeData,
    status: PaymentAttemptStatus,
  ): Promise<(Payment & { booking: Booking | null }) | null> {
    const {
      tx_ref: txRef,
      currency = "NGN",
      id: transactionId,
      payment_type: paymentMethod,
      flw_ref: flutterwaveReference,
      amount: webhookAmount,
      charged_amount: amountCharged,
    } = data;

    const [booking, extension] = await Promise.all([
      this.databaseService.booking.findFirst({
        where: { paymentIntent: txRef },
        select: { id: true, totalAmount: true },
      }),
      this.databaseService.extension.findFirst({
        where: { paymentIntent: txRef },
        select: { id: true, totalAmount: true },
      }),
    ]);

    let bookingId: string | undefined;
    let extensionId: string | undefined;
    let amountExpected = webhookAmount;

    if (booking && extension) {
      this.logger.error("Duplicate txRef matched both booking and extension, skipping webhook", {
        txRef,
        bookingId: booking.id,
        extensionId: extension.id,
      });
      return null;
    }

    if (booking) {
      bookingId = booking.id;
      amountExpected = booking.totalAmount.toNumber() ?? amountExpected;
    } else if (extension) {
      extensionId = extension.id;
      amountExpected = extension.totalAmount.toNumber() ?? amountExpected;
    } else {
      this.logger.error("No booking or extension found for txRef, cannot create payment record", {
        txRef,
      });
      return null;
    }

    this.logger.log("Creating payment record from webhook", {
      txRef,
      bookingId,
      extensionId,
      amountExpected,
      amountCharged,
      status,
    });

    return this.databaseService.payment.upsert({
      where: { txRef },
      // Intentionally keep update empty for idempotency:
      // once a txRef is recorded, retries should not mutate the existing payment row.
      update: {},
      create: {
        txRef,
        amountExpected,
        amountCharged,
        currency,
        status,
        flutterwaveTransactionId: String(transactionId),
        flutterwaveReference,
        paymentMethod,
        confirmedAt: new Date(),
        webhookPayload: data as unknown as Prisma.JsonObject,
        ...(bookingId && { bookingId }),
        ...(extensionId && { extensionId }),
      },
      include: { booking: true },
    });
  }
}
