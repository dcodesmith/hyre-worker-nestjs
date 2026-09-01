import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus, Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { USER } from "../auth/auth.const";
import { AuthErrorCode, AuthUnauthorizedException } from "../auth/auth.error";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import {
  BookingFetchFailedException,
  BookingNotFoundException,
  BookingReceiptGenerationFailedException,
  BookingReceiptNotAvailableException,
} from "./booking.error";
import type {
  BookingReceiptLineItem,
  BookingReceiptModel,
  BookingReceiptPdf,
} from "./booking-receipt.model";
import { BookingReceiptPdfService } from "./booking-receipt-pdf.service";
import { GuestBookingAccessService } from "./guest-booking-access.service";

const SETTLED_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];
const MONEY_TOLERANCE = new Decimal("0.01");

const receiptPaymentSelect = {
  id: true,
  txRef: true,
  amountExpected: true,
  amountCharged: true,
  currency: true,
  status: true,
  webhookPayload: true,
} satisfies Prisma.PaymentSelect;

const receiptBookingSelect = {
  bookingReference: true,
  status: true,
  paymentStatus: true,
  paymentId: true,
  guestUser: true,
  startDate: true,
  endDate: true,
  pickupLocation: true,
  returnLocation: true,
  totalAmount: true,
  netTotal: true,
  securityDetailCost: true,
  fuelUpgradeCost: true,
  platformCustomerServiceFeeAmount: true,
  subtotalBeforeVat: true,
  vatAmount: true,
  vatRatePercent: true,
  referralDiscountAmount: true,
  referralCreditsUsed: true,
  user: { select: { name: true } },
  car: { select: { make: true, model: true, year: true, color: true } },
  chauffeur: { select: { name: true } },
  customerPayments: { select: receiptPaymentSelect },
  legs: {
    select: {
      extensions: {
        where: {
          status: "ACTIVE",
          paymentStatus: { in: SETTLED_PAYMENT_STATUSES },
        },
        select: {
          status: true,
          paymentStatus: true,
          paymentId: true,
          totalAmount: true,
          netTotal: true,
          platformCustomerServiceFeeAmount: true,
          subtotalBeforeVat: true,
          vatAmount: true,
          vatRatePercent: true,
          customerPayments: { select: receiptPaymentSelect },
        },
      },
    },
  },
} satisfies Prisma.BookingSelect;

type ReceiptBooking = Prisma.BookingGetPayload<{ select: typeof receiptBookingSelect }>;
type ReceiptPayment = ReceiptBooking["customerPayments"][number];
type ReceiptExtension = ReceiptBooking["legs"][number]["extensions"][number];

@Injectable()
export class BookingReceiptService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly guestBookingAccessService: GuestBookingAccessService,
    private readonly pdfService: BookingReceiptPdfService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingReceiptService.name);
  }

  async generateReceipt(
    bookingId: string,
    sessionUser: AuthSession["user"] | null,
    guestToken?: string,
  ): Promise<BookingReceiptPdf> {
    const accessFilter = await this.resolveAccessFilter(bookingId, sessionUser, guestToken);
    const booking = await this.loadBooking(bookingId, accessFilter);
    const receipt = this.buildReceipt(booking);

    try {
      const buffer = await this.pdfService.render(receipt);
      return {
        buffer,
        fileName: `Tripdly-receipt-${this.sanitizeBookingReference(booking.bookingReference)}.pdf`,
      };
    } catch (error) {
      this.logger.error(
        {
          bookingId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to generate booking receipt PDF",
      );
      throw new BookingReceiptGenerationFailedException();
    }
  }

  private async resolveAccessFilter(
    bookingId: string,
    sessionUser: AuthSession["user"] | null,
    guestToken?: string,
  ): Promise<Prisma.BookingWhereInput> {
    if (guestToken?.trim()) {
      await this.guestBookingAccessService.assertBookingAccess(bookingId, guestToken);
      return { userId: null };
    }

    if (!sessionUser) {
      throw new AuthUnauthorizedException(
        AuthErrorCode.AUTH_NOT_AUTHENTICATED,
        "Not authenticated",
        "Not Authenticated",
      );
    }

    if (!sessionUser.roles.includes(USER)) {
      throw new BookingNotFoundException();
    }

    return { userId: sessionUser.id };
  }

  private async loadBooking(
    bookingId: string,
    accessFilter: Prisma.BookingWhereInput,
  ): Promise<ReceiptBooking> {
    try {
      const booking = await this.databaseService.booking.findFirst({
        where: { id: bookingId, deletedAt: null, ...accessFilter },
        select: receiptBookingSelect,
      });
      if (!booking) throw new BookingNotFoundException();
      return booking;
    } catch (error) {
      if (error instanceof BookingNotFoundException) throw error;
      this.logger.error(
        {
          bookingId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to load booking receipt data",
      );
      throw new BookingFetchFailedException();
    }
  }

  private buildReceipt(booking: ReceiptBooking): BookingReceiptModel {
    if (
      booking.status !== BookingStatus.COMPLETED ||
      !SETTLED_PAYMENT_STATUSES.includes(booking.paymentStatus)
    ) {
      throw new BookingReceiptNotAvailableException();
    }

    const bookingNet = this.requiredMoney(booking.netTotal);
    const securityDetail = this.optionalMoney(booking.securityDetailCost);
    const fuelUpgrade = this.optionalMoney(booking.fuelUpgradeCost);
    const bookingFee = this.requiredMoney(booking.platformCustomerServiceFeeAmount);
    const referralDiscount = this.money(booking.referralDiscountAmount);
    const referralCredits = this.money(booking.referralCreditsUsed);
    const bookingSubtotal = this.requiredMoney(booking.subtotalBeforeVat);
    const bookingVat = this.requiredMoney(booking.vatAmount);
    const bookingVatRate = this.requiredMoney(booking.vatRatePercent);
    const bookingTotal = this.money(booking.totalAmount);

    this.assertEqual(
      bookingNet
        .add(securityDetail)
        .add(fuelUpgrade)
        .add(bookingFee)
        .sub(referralDiscount)
        .sub(referralCredits),
      bookingSubtotal,
    );
    this.assertEqual(bookingSubtotal.add(bookingVat), bookingTotal);

    const bookingPayment = this.getCanonicalPayment(
      booking.customerPayments,
      booking.paymentId,
      booking.paymentStatus,
      bookingTotal,
    );
    const extensions = booking.legs
      .flatMap((leg) => leg.extensions)
      .filter(
        (extension) =>
          extension.status === "ACTIVE" &&
          SETTLED_PAYMENT_STATUSES.includes(extension.paymentStatus),
      );

    let extensionNet = new Decimal(0);
    let extensionFees = new Decimal(0);
    let extensionTotal = new Decimal(0);
    let paymentAdjustment = this.requiredMoney(bookingPayment.amountCharged).sub(bookingTotal);
    let refunds = this.getRefundAmount(bookingPayment, booking.paymentStatus);
    const vatByRate = new Map<string, Decimal>([[bookingVatRate.toString(), bookingVat]]);

    for (const extension of extensions) {
      const financials = this.getExtensionFinancials(extension);
      const payment = this.getCanonicalPayment(
        extension.customerPayments,
        extension.paymentId,
        extension.paymentStatus,
        financials.total,
      );
      extensionNet = extensionNet.add(financials.net);
      extensionFees = extensionFees.add(financials.fee);
      extensionTotal = extensionTotal.add(financials.total);
      paymentAdjustment = paymentAdjustment.add(
        this.requiredMoney(payment.amountCharged).sub(financials.total),
      );
      refunds = refunds.add(this.getRefundAmount(payment, extension.paymentStatus));
      const rate = financials.vatRate.toString();
      vatByRate.set(rate, (vatByRate.get(rate) ?? new Decimal(0)).add(financials.vat));
      this.assertCurrency(bookingPayment.currency, payment.currency);
    }

    const lineItems: BookingReceiptLineItem[] = [
      { label: "Base booking charge", amount: bookingNet.toNumber() },
    ];
    this.addPositiveLine(lineItems, `Paid extensions (${extensions.length})`, extensionNet);
    this.addPositiveLine(lineItems, "Security detail", securityDetail);
    this.addPositiveLine(lineItems, "Fuel upgrade", fuelUpgrade);
    this.addPositiveLine(lineItems, "Platform service fee", bookingFee.add(extensionFees));
    this.addNegativeLine(lineItems, "Referral discount", referralDiscount);
    this.addNegativeLine(lineItems, "Referral credits used", referralCredits);
    for (const [rate, amount] of vatByRate) {
      this.addPositiveLine(lineItems, `VAT (${this.formatRate(rate)}%)`, amount);
    }
    if (!paymentAdjustment.isZero()) {
      lineItems.push({
        label: "Payment rounding adjustment",
        amount: paymentAdjustment.toNumber(),
      });
    }
    this.addNegativeLine(lineItems, "Refunds", refunds);

    const totalPaid = bookingTotal.add(extensionTotal).add(paymentAdjustment).sub(refunds);
    const displayedTotal = lineItems.reduce(
      (total, lineItem) => total.add(lineItem.amount),
      new Decimal(0),
    );
    this.assertEqual(displayedTotal, totalPaid);

    return {
      bookingReference: booking.bookingReference,
      generatedAt: new Date(),
      customerName: booking.user?.name?.trim() || this.guestName(booking.guestUser) || null,
      vehicle: this.formatVehicle(booking.car),
      chauffeurName: booking.chauffeur?.name?.trim() || null,
      bookingStart: booking.startDate,
      bookingEnd: booking.endDate,
      pickupLocation: booking.pickupLocation,
      returnLocation: booking.returnLocation,
      paymentStatus: this.getOverallPaymentStatus(totalPaid, refunds),
      paymentReference: bookingPayment.txRef,
      currency: bookingPayment.currency.trim().toUpperCase(),
      lineItems,
      totalPaid: totalPaid.toNumber(),
    };
  }

  private getExtensionFinancials(extension: ReceiptExtension) {
    const net = this.requiredMoney(extension.netTotal);
    const fee = this.requiredMoney(extension.platformCustomerServiceFeeAmount);
    const subtotal = this.requiredMoney(extension.subtotalBeforeVat);
    const vat = this.requiredMoney(extension.vatAmount);
    const vatRate = this.requiredMoney(extension.vatRatePercent);
    const total = this.money(extension.totalAmount);
    this.assertEqual(net.add(fee), subtotal);
    this.assertEqual(subtotal.add(vat), total);
    return { net, fee, vat, vatRate, total };
  }

  private getCanonicalPayment(
    payments: ReceiptPayment[],
    paymentId: string | null,
    paymentStatus: PaymentStatus,
    expectedTotal: Decimal,
  ): ReceiptPayment {
    const payment = paymentId ? payments.find(({ id }) => id === paymentId) : undefined;
    if (!payment || payment.status !== this.expectedAttemptStatus(paymentStatus)) {
      throw new BookingReceiptNotAvailableException();
    }

    const amountCharged = this.requiredMoney(payment.amountCharged);
    this.assertEqual(this.money(payment.amountExpected), expectedTotal);
    if (amountCharged.sub(expectedTotal).abs().gt(MONEY_TOLERANCE)) {
      throw new BookingReceiptNotAvailableException();
    }
    if (!payment.currency.trim()) throw new BookingReceiptNotAvailableException();
    return payment;
  }

  private expectedAttemptStatus(paymentStatus: PaymentStatus): PaymentAttemptStatus {
    if (paymentStatus === PaymentStatus.PAID) return PaymentAttemptStatus.SUCCESSFUL;
    if (paymentStatus === PaymentStatus.PARTIALLY_REFUNDED) {
      return PaymentAttemptStatus.PARTIALLY_REFUNDED;
    }
    if (paymentStatus === PaymentStatus.REFUNDED) return PaymentAttemptStatus.REFUNDED;
    throw new BookingReceiptNotAvailableException();
  }

  private getRefundAmount(payment: ReceiptPayment, paymentStatus: PaymentStatus): Decimal {
    if (paymentStatus === PaymentStatus.PAID) return new Decimal(0);
    const payload = payment.webhookPayload;
    const value =
      payload && typeof payload === "object" && !Array.isArray(payload) && "refundAmount" in payload
        ? payload.refundAmount
        : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BookingReceiptNotAvailableException();
    }

    const refund = new Decimal(value);
    const charged = this.requiredMoney(payment.amountCharged);
    if (refund.lte(0) || refund.gt(charged)) throw new BookingReceiptNotAvailableException();
    if (paymentStatus === PaymentStatus.REFUNDED && !refund.eq(charged)) {
      throw new BookingReceiptNotAvailableException();
    }
    if (paymentStatus === PaymentStatus.PARTIALLY_REFUNDED && !refund.lt(charged)) {
      throw new BookingReceiptNotAvailableException();
    }
    return refund;
  }

  private getOverallPaymentStatus(
    totalPaid: Decimal,
    refunds: Decimal,
  ): BookingReceiptModel["paymentStatus"] {
    if (refunds.eq(0)) return "PAID";
    return totalPaid.eq(0) ? "REFUNDED" : "PARTIALLY_REFUNDED";
  }

  private requiredMoney(value: Prisma.Decimal | null): Decimal {
    if (value === null) throw new BookingReceiptNotAvailableException();
    return this.money(value);
  }

  private optionalMoney(value: Prisma.Decimal | null): Decimal {
    return value === null ? new Decimal(0) : this.money(value);
  }

  private money(value: Prisma.Decimal | Decimal | number): Decimal {
    return new Decimal(value.toString());
  }

  private assertEqual(actual: Decimal, expected: Decimal): void {
    if (!actual.eq(expected)) throw new BookingReceiptNotAvailableException();
  }

  private assertCurrency(expected: string, actual: string): void {
    if (expected.trim().toUpperCase() !== actual.trim().toUpperCase()) {
      throw new BookingReceiptNotAvailableException();
    }
  }

  private addPositiveLine(
    lineItems: BookingReceiptLineItem[],
    label: string,
    amount: Decimal,
  ): void {
    if (amount.gt(0)) lineItems.push({ label, amount: amount.toNumber() });
  }

  private addNegativeLine(
    lineItems: BookingReceiptLineItem[],
    label: string,
    amount: Decimal,
  ): void {
    if (amount.gt(0)) lineItems.push({ label, amount: amount.negated().toNumber() });
  }

  private formatRate(rate: string): string {
    return new Decimal(rate).toDecimalPlaces(2).toString();
  }

  private formatVehicle(car: {
    make: string;
    model: string;
    year: number;
    color: string | null;
  }): string {
    const details = [car.year.toString(), car.color?.trim()].filter(Boolean).join(", ");
    const suffix = details ? ` (${details})` : "";
    return `${car.make} ${car.model}${suffix}`;
  }

  private guestName(value: Prisma.JsonValue): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const name = "name" in value ? value.name : undefined;
    return typeof name === "string" ? name.trim() || null : null;
  }

  private sanitizeBookingReference(bookingReference: string): string {
    return bookingReference.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  }
}
