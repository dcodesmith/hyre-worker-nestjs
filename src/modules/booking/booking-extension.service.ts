import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { BookingStatus, BookingType, ExtensionEventType, PaymentStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { addDays, addHours, differenceInHours, startOfDay } from "date-fns";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RatesService } from "../rates/rates.service";
import type { CreateExtensionResponse } from "./booking.interface";
import type { CreateExtensionBodyDto } from "./dto/create-extension.dto";

@Injectable()
export class BookingExtensionService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ratesService: RatesService,
    private readonly flutterwaveService: FlutterwaveService,
  ) {}

  async createExtension(
    bookingId: string,
    body: CreateExtensionBodyDto,
    user: AuthSession["user"],
  ): Promise<CreateExtensionResponse> {
    const booking = await this.databaseService.booking.findFirst({
      where: {
        id: bookingId,
        userId: user.id,
        status: {
          in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE],
        },
      },
      include: {
        car: {
          select: {
            hourlyRate: true,
          },
        },
        legs: {
          include: {
            extensions: {
              orderBy: {
                extensionEndTime: "desc",
              },
            },
          },
          orderBy: {
            legDate: "desc",
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException("Confirmed or active booking not found");
    }

    if (booking.type !== BookingType.DAY) {
      throw new BadRequestException("Only DAY bookings can be extended");
    }

    const bookingLeg = booking.legs[0];

    if (!bookingLeg) {
      throw new BadRequestException("No booking leg found for this booking");
    }

    const latestPaidActiveExtension = bookingLeg.extensions.find(
      (extension) =>
        extension.status === "ACTIVE" && extension.paymentStatus === PaymentStatus.PAID,
    );

    const extensionStartTime = latestPaidActiveExtension
      ? new Date(latestPaidActiveExtension.extensionEndTime)
      : new Date(bookingLeg.legEndTime);
    const midnight = startOfDay(addDays(bookingLeg.legDate, 1));
    const maxHours = differenceInHours(midnight, extensionStartTime);

    if (maxHours < 1) {
      throw new BadRequestException("Booking can no longer be extended today");
    }

    if (body.hours > maxHours) {
      throw new BadRequestException(`Maximum extension is ${maxHours} hour(s) for today`);
    }

    const rates = await this.ratesService.getRates();
    const baseAmount = new Decimal(booking.car.hourlyRate).mul(body.hours);
    const customerServiceFee = baseAmount
      .mul(new Decimal(rates.platformCustomerServiceFeeRatePercent))
      .div(100);
    const subTotal = baseAmount.add(customerServiceFee);
    const vatAmount = subTotal.mul(new Decimal(rates.vatRatePercent)).div(100);
    const totalAmount = subTotal.add(vatAmount);
    const fleetFee = baseAmount
      .mul(new Decimal(rates.platformFleetOwnerCommissionRatePercent))
      .div(100);
    const fleetPayout = baseAmount.sub(fleetFee);

    const paymentIntent = await this.flutterwaveService.createPaymentIntent({
      amount: totalAmount.toNumber(),
      customer: {
        email: user.email,
        name: user.name || undefined,
      },
      callbackUrl: body.callbackUrl,
      transactionType: "booking_extension",
      metadata: {
        bookingId: booking.id,
        source: "booking_extension_endpoint",
      },
      idempotencyKey: `ext-${booking.id}-${randomUUID()}`,
    });

    const extensionEndTime = addHours(extensionStartTime, body.hours);
    const extension = await this.databaseService.extension.create({
      data: {
        bookingLegId: bookingLeg.id,
        extensionStartTime,
        extensionEndTime,
        extendedDurationHours: body.hours,
        eventType: ExtensionEventType.HOURLY_ADDITION,
        status: "PENDING",
        paymentStatus: PaymentStatus.UNPAID,
        totalAmount,
        netTotal: baseAmount,
        paymentIntent: paymentIntent.paymentIntentId,
        platformCustomerServiceFeeAmount: customerServiceFee,
        platformCustomerServiceFeeRatePercent: rates.platformCustomerServiceFeeRatePercent,
        subtotalBeforeVat: subTotal,
        vatAmount,
        vatRatePercent: rates.vatRatePercent,
        platformFleetOwnerCommissionAmount: fleetFee,
        platformFleetOwnerCommissionRatePercent: rates.platformFleetOwnerCommissionRatePercent,
        fleetOwnerPayoutAmountNet: fleetPayout,
      },
      select: {
        id: true,
      },
    });

    return {
      extensionId: extension.id,
      paymentIntentId: paymentIntent.paymentIntentId,
      checkoutUrl: paymentIntent.checkoutUrl,
    };
  }
}
