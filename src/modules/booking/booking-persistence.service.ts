import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Booking,
  BookingReferralStatus,
  BookingStatus,
  FlightStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import Decimal from "decimal.js";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import { BOOKING_PAYMENT_SESSION_DURATION_MS } from "./booking.const";
import { BookingCreationFailedException, CarNotFoundException } from "./booking.error";
import type {
  CarWithPricing,
  FlightDataForBooking,
  GeneratedLeg,
  ReferralEligibility,
} from "./booking.interface";
import type { BookingFinancials } from "./booking-calculation.interface";
import type { CreateBookingInput } from "./dto/create-booking.dto";

type FlightRecordWriter = {
  flight: {
    upsert(args: Prisma.FlightUpsertArgs): Promise<{ id: string }>;
    updateMany(args: Prisma.FlightUpdateManyArgs): Promise<{ count: number }>;
  };
};

@Injectable()
export class BookingPersistenceService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<EnvConfig>,
  ) {}

  async fetchCarWithPricing(carId: string, tx?: Prisma.TransactionClient): Promise<CarWithPricing> {
    const reader = tx ?? this.databaseService;
    const car = await reader.car.findUnique({
      where: { id: carId },
      select: {
        id: true,
        ownerId: true,
        dayRate: true,
        nightRate: true,
        fullDayRate: true,
        airportPickupRate: true,
        fuelUpgradeRate: true,
        pricingIncludesFuel: true,
      },
    });

    if (!car) {
      throw new CarNotFoundException(carId);
    }

    return car;
  }

  async markBookingUnpaid(bookingId: string): Promise<void> {
    await this.databaseService.booking.updateMany({
      where: { id: bookingId, paymentStatus: { not: PaymentStatus.PAID } },
      data: { paymentStatus: PaymentStatus.UNPAID },
    });
  }

  async createFlightRecordIfNeeded(
    tx: FlightRecordWriter,
    booking: CreateBookingInput,
    flightData: FlightDataForBooking | null,
  ): Promise<string | null> {
    if (!flightData || booking.bookingType !== "AIRPORT_PICKUP") {
      return null;
    }

    // Intentionally keep update empty: flight rows are treated as immutable snapshots.
    // Subsequent bookings should reuse the existing row rather than mutate it.
    const defaultDestinationCode =
      this.configService.get("DEFAULT_DESTINATION_CODE", { infer: true }) ?? "DNMM";
    const flightRecord = await tx.flight.upsert({
      where: { id: flightData.flightId },
      create: {
        id: flightData.flightId,
        flightNumber: flightData.flightNumber.toUpperCase(),
        flightDate: flightData.departureTime,
        faFlightId: flightData.flightId,
        originCode: flightData.originCode ?? "UNKNOWN",
        originCodeIATA: flightData.originCodeIATA,
        originTimezone: flightData.originTimezone,
        originName: flightData.originName,
        destinationCode: flightData.destinationCode ?? defaultDestinationCode,
        destinationCodeIATA: flightData.destinationIATA,
        destinationName: flightData.destinationName,
        destinationCity: flightData.destinationCity,
        scheduledDeparture: flightData.departureTime,
        scheduledArrival: flightData.arrivalTime,
        status: FlightStatus.SCHEDULED,
        alertEnabled: false,
      },
      update: {},
      select: { id: true },
    });
    await tx.flight.updateMany({
      where: {
        id: flightRecord.id,
        scheduledDeparture: null,
      },
      data: {
        flightDate: flightData.departureTime,
        scheduledDeparture: flightData.departureTime,
        originTimezone: flightData.originTimezone,
      },
    });

    return flightRecord.id;
  }

  async createBookingRecord(
    tx: Prisma.TransactionClient,
    params: {
      bookingReference: string;
      car: CarWithPricing;
      userId: string | null;
      guestUser: {
        email: string;
        name: string;
        phoneNumber: string | null;
        guestContactSource: "WEB_GUEST_FORM" | "WHATSAPP_AGENT";
        preferredNotificationChannel: "EMAIL_AND_WHATSAPP" | "EMAIL_ONLY" | "WHATSAPP_ONLY";
      } | null;
      booking: CreateBookingInput;
      financials: BookingFinancials;
      referralEligibility: ReferralEligibility;
      flightRecordId: string | null;
      legs: GeneratedLeg[];
    },
  ): Promise<Booking> {
    const data = this.buildBookingData(params);
    return tx.booking.create({ data });
  }

  private buildBookingData(params: {
    bookingReference: string;
    car: CarWithPricing;
    userId: string | null;
    guestUser: {
      email: string;
      name: string;
      phoneNumber: string | null;
      guestContactSource: "WEB_GUEST_FORM" | "WHATSAPP_AGENT";
      preferredNotificationChannel: "EMAIL_AND_WHATSAPP" | "EMAIL_ONLY" | "WHATSAPP_ONLY";
    } | null;
    booking: CreateBookingInput;
    financials: BookingFinancials;
    referralEligibility: ReferralEligibility;
    flightRecordId: string | null;
    legs: GeneratedLeg[];
  }) {
    const {
      bookingReference,
      car,
      userId,
      guestUser,
      booking,
      financials,
      referralEligibility,
      flightRecordId,
      legs,
    } = params;

    if (!financials.numberOfLegs) {
      throw new BookingCreationFailedException(
        "Cannot create booking: number of legs must be greater than zero",
      );
    }

    return {
      bookingReference,
      carId: car.id,
      userId,
      guestUser,
      type: booking.bookingType,
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      paymentSessionExpiresAt: new Date(Date.now() + BOOKING_PAYMENT_SESSION_DURATION_MS),
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupLocation: booking.pickupAddress,
      returnLocation:
        booking.sameLocation === false ? booking.dropOffAddress : booking.pickupAddress,
      specialRequests: booking.specialRequests ?? null,
      flightNumber: booking.flightNumber ?? null,
      flightId: flightRecordId,
      totalAmount: financials.totalAmount,
      netTotal: financials.netTotal,
      securityDetailCost: financials.securityDetailCost.gt(0)
        ? financials.securityDetailCost
        : null,
      fuelUpgradeCost: financials.fuelUpgradeCost.gt(0) ? financials.fuelUpgradeCost : null,
      platformCustomerServiceFeeRatePercent: financials.platformCustomerServiceFeeRatePercent,
      platformCustomerServiceFeeAmount: financials.platformCustomerServiceFeeAmount,
      subtotalBeforeVat: financials.subtotalAfterDiscounts,
      vatRatePercent: financials.vatRatePercent,
      vatAmount: financials.vatAmount,
      platformFleetOwnerCommissionRatePercent: financials.platformFleetOwnerCommissionRatePercent,
      platformFleetOwnerCommissionAmount: financials.platformFleetOwnerCommissionAmount,
      fleetOwnerPayoutAmountNet: financials.fleetOwnerPayoutAmountNet,
      referralReferrerUserId: referralEligibility.eligible
        ? referralEligibility.referrerUserId
        : null,
      referralDiscountAmount: referralEligibility.discountAmount,
      referralStatus: referralEligibility.eligible
        ? BookingReferralStatus.RESERVED
        : BookingReferralStatus.NONE,
      referralCreditsUsed: financials.creditsUsed,
      referralCreditsReserved: financials.creditsUsed,
      legs: this.buildBookingLegsData({ legs, financials }),
    };
  }

  private buildBookingLegsData(params: { legs: GeneratedLeg[]; financials: BookingFinancials }) {
    const { legs, financials } = params;
    if (legs.length !== financials.legPrices.length) {
      throw new BookingCreationFailedException(
        `Cannot create booking: legs/legPrices mismatch (${legs.length} vs ${financials.legPrices.length})`,
      );
    }

    if (financials.numberOfLegs !== legs.length) {
      throw new BookingCreationFailedException(
        `Cannot create booking: financials.numberOfLegs (${financials.numberOfLegs}) does not match legs.length (${legs.length})`,
      );
    }

    const numberOfLegs = financials.numberOfLegs;
    const commissionPerLeg = financials.platformFleetOwnerCommissionAmount.div(numberOfLegs);
    const netPerLeg = financials.netTotal.div(numberOfLegs);
    const earningsPerLeg = netPerLeg.sub(commissionPerLeg);

    return {
      create: legs.map((leg, index) => ({
        legDate: leg.legDate,
        legStartTime: leg.legStartTime,
        legEndTime: leg.legEndTime,
        totalDailyPrice: financials.legPrices[index]?.price ?? new Decimal(0),
        itemsNetValueForLeg: netPerLeg,
        platformCommissionRateOnLeg: financials.platformFleetOwnerCommissionRatePercent,
        platformCommissionAmountOnLeg: commissionPerLeg,
        fleetOwnerEarningForLeg: earningsPerLeg,
      })),
    };
  }
}
