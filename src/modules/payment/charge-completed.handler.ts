import { Injectable } from "@nestjs/common";
import type { Booking, Payment, Prisma } from "@prisma/client";
import { PaymentAttemptStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { ExtensionConfirmationService } from "../booking/extension-confirmation.service";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveChargeData } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";

const MONEY_TOLERANCE = 0.01;

@Injectable()
export class ChargeCompletedHandler {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly bookingConfirmationService: BookingConfirmationService,
    private readonly extensionConfirmationService: ExtensionConfirmationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChargeCompletedHandler.name);
  }

  async handle(data: FlutterwaveChargeData): Promise<void> {
    const { tx_ref, id: transactionId, status, charged_amount } = data;

    this.logger.info(
      {
        txRef: tx_ref,
        transactionId,
        status,
        chargedAmount: charged_amount,
      },
      "Processing charge.completed webhook",
    );

    if (!this.validateChargeWebhookFields(tx_ref, transactionId)) {
      return;
    }

    try {
      await this.processVerifiedCharge(data);
    } catch (error) {
      this.logger.error(
        {
          txRef: tx_ref,
          transactionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to verify transaction",
      );
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
        { txRef },
        "Missing id in charge.completed webhook, skipping to prevent data corruption",
      );
      return false;
    }

    return true;
  }

  private async processVerifiedCharge(data: FlutterwaveChargeData): Promise<void> {
    const {
      tx_ref: txRef,
      id: transactionId,
      charged_amount: chargedAmount,
      currency: webhookCurrency,
    } = data;

    const verification = await this.flutterwaveService.verifyTransaction(transactionId.toString());
    const verificationData = this.validateVerification(
      verification,
      txRef,
      transactionId,
      chargedAmount,
      webhookCurrency,
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
      this.logger.warn({ txRef }, "Payment not found and could not be created for webhook");
      return;
    }

    this.logger.info(
      {
        txRef,
        paymentId: payment.id,
        status: paymentStatus,
        verifiedStatus: verificationData.status,
      },
      "Payment created from webhook",
    );

    if (payment.status !== PaymentAttemptStatus.SUCCESSFUL) {
      return;
    }

    if (!this.matchesExpectedAmountAndCurrency(payment, verificationData)) {
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
    webhookCurrency: string,
  ): { status: string; charged_amount: number; currency: string } | null {
    if (verification.status !== "success") {
      this.logger.warn(
        {
          txRef,
          transactionId,
          verificationStatus: verification.status,
        },
        "Transaction verification failed",
      );
      return null;
    }

    const data = verification.data;
    if (!data) {
      this.logger.warn({ txRef, transactionId }, "Transaction verification returned no data");
      return null;
    }

    if (data.tx_ref !== txRef) {
      this.logger.warn(
        {
          webhookTxRef: txRef,
          verifiedTxRef: data.tx_ref,
          transactionId,
        },
        "Transaction verification tx_ref mismatch",
      );
      return null;
    }

    if (data.id !== transactionId) {
      this.logger.warn(
        {
          webhookTransactionId: transactionId,
          verifiedTransactionId: data.id,
          txRef,
        },
        "Transaction verification id mismatch",
      );
      return null;
    }

    if (data.charged_amount !== chargedAmount) {
      this.logger.warn(
        {
          txRef,
          transactionId,
          webhookChargedAmount: chargedAmount,
          verifiedChargedAmount: data.charged_amount,
        },
        "Transaction verification charged_amount mismatch",
      );
      return null;
    }

    if ((data.currency ?? "").toUpperCase() !== (webhookCurrency ?? "").toUpperCase()) {
      this.logger.warn(
        {
          txRef,
          transactionId,
          webhookCurrency: (webhookCurrency ?? "").toUpperCase(),
          verifiedCurrency: (data.currency ?? "").toUpperCase(),
        },
        "Transaction verification currency mismatch",
      );
      return null;
    }

    return {
      status: data.status,
      charged_amount: data.charged_amount,
      currency: data.currency,
    };
  }

  private matchesExpectedAmountAndCurrency(
    payment: Payment,
    verificationData: { charged_amount: number; currency: string },
  ): boolean {
    const hasPersistedAmountCharged = payment.amountCharged != null;
    const chargedAmountSource = hasPersistedAmountCharged ? "persisted" : "verification";
    if (!hasPersistedAmountCharged) {
      this.logger.warn(
        {
          paymentId: payment.id,
          txRef: payment.txRef,
          chargedAmountSource,
          verificationChargedAmount: verificationData.charged_amount,
        },
        "Payment is missing amountCharged; using verified charged amount for confirmation checks",
      );
    }

    const expectedAmount = this.toNumber(payment.amountExpected);
    const chargedAmount = hasPersistedAmountCharged
      ? this.toNumber(payment.amountCharged)
      : verificationData.charged_amount;
    const amountDifference = Math.abs(chargedAmount - expectedAmount);
    if (amountDifference > MONEY_TOLERANCE) {
      this.logger.warn(
        {
          paymentId: payment.id,
          txRef: payment.txRef,
          expectedAmount,
          chargedAmount,
          chargedAmountSource,
          verificationChargedAmount: verificationData.charged_amount,
          difference: amountDifference,
        },
        "Payment amount mismatch against expected booking/extension amount; blocking confirmation",
      );
      return false;
    }

    const persistedCurrency = (payment.currency ?? "").trim();
    const expectedCurrencySource = persistedCurrency ? "persisted" : "verification";
    const expectedCurrency = (persistedCurrency || verificationData.currency || "")
      .trim()
      .toUpperCase();
    const verifiedCurrency = (verificationData.currency ?? "").trim().toUpperCase();
    if (!persistedCurrency) {
      this.logger.warn(
        {
          paymentId: payment.id,
          txRef: payment.txRef,
          expectedCurrencySource,
          verifiedCurrency,
        },
        "Payment is missing currency; using verified currency for confirmation checks",
      );
    }

    if (!expectedCurrency || expectedCurrency !== verifiedCurrency) {
      this.logger.warn(
        {
          paymentId: payment.id,
          txRef: payment.txRef,
          expectedCurrency,
          expectedCurrencySource,
          verifiedCurrency,
        },
        "Payment currency mismatch against expected booking/extension currency; blocking confirmation",
      );
      return false;
    }

    return true;
  }

  private toNumber(value: Decimal | number): number {
    return value instanceof Decimal ? value.toNumber() : value;
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
      this.logger.error(
        {
          txRef,
          bookingId: booking.id,
          extensionId: extension.id,
        },
        "Duplicate txRef matched both booking and extension, skipping webhook",
      );
      return null;
    }

    if (booking) {
      bookingId = booking.id;
      amountExpected = booking.totalAmount.toNumber() || amountExpected;
    } else if (extension) {
      extensionId = extension.id;
      amountExpected = extension.totalAmount.toNumber() || amountExpected;
    } else {
      this.logger.error(
        {
          txRef,
        },
        "No booking or extension found for txRef, cannot create payment record",
      );
      return null;
    }

    this.logger.info(
      {
        txRef,
        bookingId,
        extensionId,
        amountExpected,
        amountCharged,
        status,
      },
      "Creating payment record from webhook",
    );

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
