import { Injectable, Logger } from "@nestjs/common";
import { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
  ) {}

  /**
   * Initiates a payout for a completed booking.
   * It creates a PayoutTransaction record and triggers the actual payout via Flutterwave.
   */
  async initiatePayout(booking: BookingWithRelations) {
    const existingPayout = await this.databaseService.payoutTransaction.findFirst({
      where: {
        bookingId: booking.id,
        status: { in: ["PENDING_DISBURSEMENT", "PROCESSING"] },
      },
    });

    if (existingPayout) {
      this.logger.log("Payout already in progress for booking", { bookingId: booking.id });
      return;
    }

    if (!booking.fleetOwnerPayoutAmountNet || booking.fleetOwnerPayoutAmountNet.isZero()) {
      this.logger.log("Booking has no payout amount. Skipping payout", { bookingId: booking.id });
      return;
    }

    const fleetOwner = booking.car.owner;
    if (!fleetOwner.bankDetailsId) {
      this.logger.warn("Fleet owner has no bank details. Cannot process payout for booking", {
        fleetOwnerId: fleetOwner.id,
        bookingId: booking.id,
      });
      return;
    }

    const bankDetails = await this.databaseService.bankDetails.findUnique({
      where: { id: fleetOwner.bankDetailsId },
    });

    if (!bankDetails?.isVerified) {
      this.logger.warn(
        "Bank details for fleet owner not found or not verified. Cannot process payout for booking",
        {
          fleetOwnerId: fleetOwner.id,
          bookingId: booking.id,
          detailsFound: !!bankDetails,
          isVerified: bankDetails?.isVerified,
        },
      );
      return;
    }

    const payoutAmount = booking.fleetOwnerPayoutAmountNet.toNumber();
    const reference = `payout_${booking.id}_${Date.now()}`;

    // 1. Create a PayoutTransaction record
    let payoutTransaction = await this.databaseService.payoutTransaction.create({
      data: {
        fleetOwnerId: fleetOwner.id,
        bookingId: booking.id,
        amountToPay: payoutAmount,
        currency: "NGN",
        status: "PENDING_DISBURSEMENT",
        payoutMethodDetails: `Bank: ${bankDetails.bankName}, Account: ${bankDetails.accountNumber}`,
      },
    });

    // 2. Initiate the actual payout via Flutterwave
    const payoutResult = await this.flutterwaveService.initiatePayout({
      bankDetails: {
        bankCode: bankDetails.bankCode,
        accountNumber: bankDetails.accountNumber,
        bankName: bankDetails.bankName,
      },
      amount: payoutAmount,
      reference,
      bookingId: booking.id,
    });

    // 3. Update the PayoutTransaction and Booking based on the result
    if (payoutResult?.success) {
      const transferData = payoutResult.data as any; // Type assertion since we know it's FlutterwaveTransferData when success is true
      payoutTransaction = await this.databaseService.payoutTransaction.update({
        where: { id: payoutTransaction.id },
        data: {
          status: "PROCESSING",
          payoutProviderReference: transferData.id?.toString() || "",
        },
      });
      await this.databaseService.booking.update({
        where: { id: booking.id },
        data: { overallPayoutStatus: "PROCESSING" },
      });
      this.logger.log("Payout for booking initiated successfully. Transaction ID", {
        bookingId: booking.id,
        transactionId: payoutTransaction.id,
      });
    } else {
      const errorData = payoutResult.data as { message: string };
      payoutTransaction = await this.databaseService.payoutTransaction.update({
        where: { id: payoutTransaction.id },
        data: {
          status: "FAILED",
          notes: `Flutterwave initiation failed: ${errorData.message}`,
        },
      });
      await this.databaseService.booking.update({
        where: { id: booking.id },
        data: { overallPayoutStatus: "FAILED" },
      });
      this.logger.error("Payout initiation for booking failed. Reason", {
        bookingId: booking.id,
        reason: errorData.message,
      });
    }
  }
}
