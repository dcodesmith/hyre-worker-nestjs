import { randomUUID } from "node:crypto";
import { UTCDate } from "@date-fns/utc";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { BookingStatus, BookingType, ExtensionEventType, PaymentStatus } from "@prisma/client";
import { addDays, addHours, differenceInHours, isSameDay, startOfDay } from "date-fns";
import Decimal from "decimal.js";
import { BOOKING_BUFFER_HOURS } from "../../shared/availability-buffer.helper";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RatesService } from "../rates/rates.service";
import { BLOCKING_BOOKING_STATUSES } from "./booking.const";
import type { BookingLegExtensionEligibility, CreateExtensionResponse } from "./booking.interface";
import { getDatabaseNow } from "./booking-modification-policy.helper";
import type { CreateExtensionBodyDto } from "./dto/create-extension.dto";

type ExtensionEligibilityBooking = {
  id: string;
  carId: string;
  type: BookingType;
  status: BookingStatus;
  legs: Array<{
    id: string;
    legDate: Date;
    legEndTime: Date;
    extensions: Array<{
      extensionEndTime: Date;
      status: string;
      paymentStatus: PaymentStatus;
    }>;
  }>;
};

@Injectable()
export class BookingExtensionService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ratesService: RatesService,
    private readonly flutterwaveService: FlutterwaveService,
  ) {}

  async getEligibilities(
    bookings: ExtensionEligibilityBooking[],
    canAct: boolean,
    now: Date,
  ): Promise<Map<string, BookingLegExtensionEligibility>> {
    const results = new Map<string, BookingLegExtensionEligibility>();
    for (const booking of bookings) {
      for (const leg of booking.legs) {
        results.set(leg.id, { canExtend: false, maxExtendableHours: 0 });
      }
    }

    if (!canAct) {
      return results;
    }

    const candidates: Array<{
      bookingId: string;
      bookingLegId: string;
      carId: string;
      currentEnd: Date;
      dayEnd: Date;
    }> = [];
    const today = startOfDay(new UTCDate(now));

    for (const booking of bookings) {
      if (
        booking.type !== BookingType.DAY ||
        (booking.status !== BookingStatus.CONFIRMED && booking.status !== BookingStatus.ACTIVE)
      ) {
        continue;
      }

      for (const bookingLeg of booking.legs) {
        const legDay = startOfDay(new UTCDate(bookingLeg.legDate));
        const currentEnd = this.getCurrentLegEnd(bookingLeg);
        const dayEnd = addDays(legDay, 1);
        if (legDay >= today && currentEnd > now && currentEnd < dayEnd) {
          candidates.push({
            bookingId: booking.id,
            bookingLegId: bookingLeg.id,
            carId: booking.carId,
            currentEnd,
            dayEnd,
          });
        }
      }
    }

    if (candidates.length === 0) {
      return results;
    }

    const nextBookings = await this.databaseService.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        OR: candidates.map(({ bookingId, carId, currentEnd, dayEnd }) => ({
          id: { not: bookingId },
          carId,
          startDate: {
            gte: currentEnd,
            lte: addHours(dayEnd, BOOKING_BUFFER_HOURS),
          },
        })),
      },
      select: {
        id: true,
        carId: true,
        startDate: true,
      },
      orderBy: { startDate: "asc" },
    });

    for (const candidate of candidates) {
      const nextBooking = nextBookings.find(
        (booking) =>
          booking.carId === candidate.carId &&
          booking.id !== candidate.bookingId &&
          booking.startDate >= candidate.currentEnd,
      );
      const bookingBufferLimit = nextBooking
        ? addHours(nextBooking.startDate, -BOOKING_BUFFER_HOURS)
        : candidate.dayEnd;
      const latestEnd =
        bookingBufferLimit < candidate.dayEnd ? bookingBufferLimit : candidate.dayEnd;
      const maxExtendableHours = Math.max(0, differenceInHours(latestEnd, candidate.currentEnd));

      results.set(candidate.bookingLegId, {
        canExtend: maxExtendableHours >= 1,
        maxExtendableHours,
      });
    }

    return results;
  }

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
            extensions: true,
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

    const now = await getDatabaseNow(this.databaseService);
    const bookingLeg = body.bookingLegId
      ? booking.legs.find((leg) => leg.id === body.bookingLegId)
      : booking.legs.find((leg) => isSameDay(new UTCDate(leg.legDate), new UTCDate(now)));

    if (!bookingLeg) {
      throw new BadRequestException("Booking leg not found");
    }

    const eligibility = (await this.getEligibilities([booking], true, now)).get(bookingLeg.id);
    if (!eligibility?.canExtend) {
      throw new BadRequestException("Booking leg cannot be extended");
    }

    if (body.hours > eligibility.maxExtendableHours) {
      throw new BadRequestException(
        `Maximum extension is ${eligibility.maxExtendableHours} hour(s) for this leg`,
      );
    }

    const extensionStartTimeUTC = new UTCDate(this.getCurrentLegEnd(bookingLeg));
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

    const extensionEndTime = addHours(extensionStartTimeUTC, body.hours);
    const extensionPayload = {
      bookingLegId: bookingLeg.id,
      extensionStartTime: extensionStartTimeUTC,
      extensionEndTime,
      extendedDurationHours: body.hours,
      eventType: ExtensionEventType.HOURLY_ADDITION,
      status: "PENDING" as const,
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
    };

    const existingPendingUnpaidForSameStart = bookingLeg.extensions.find(
      (extension) =>
        extension.status === "PENDING" &&
        extension.paymentStatus === PaymentStatus.UNPAID &&
        new UTCDate(extension.extensionStartTime).getTime() === extensionStartTimeUTC.getTime(),
    );

    const extension = existingPendingUnpaidForSameStart
      ? await this.databaseService.extension.update({
          where: { id: existingPendingUnpaidForSameStart.id },
          data: extensionPayload,
          select: { id: true },
        })
      : await this.databaseService.extension.create({
          data: extensionPayload,
          select: { id: true },
        });

    return {
      extensionId: extension.id,
      paymentIntentId: paymentIntent.paymentIntentId,
      checkoutUrl: paymentIntent.checkoutUrl,
    };
  }

  private getCurrentLegEnd(bookingLeg: ExtensionEligibilityBooking["legs"][number]): Date {
    return bookingLeg.extensions.reduce(
      (currentEnd, extension) =>
        extension.status === "ACTIVE" &&
        extension.paymentStatus === PaymentStatus.PAID &&
        extension.extensionEndTime > currentEnd
          ? extension.extensionEndTime
          : currentEnd,
      bookingLeg.legEndTime,
    );
  }
}
