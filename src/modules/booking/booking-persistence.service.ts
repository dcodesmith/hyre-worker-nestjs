import { Injectable } from "@nestjs/common";
import {
  Booking,
  BookingReferralStatus,
  BookingStatus,
  FlightStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import Decimal from "decimal.js";
import { DatabaseService } from "../database/database.service";
import { BookingCreationFailedException, CarNotFoundException } from "./booking.error";
import type {
  CarWithPricing,
  FlightDataForBooking,
  GeneratedLeg,
  ReferralEligibility,
} from "./booking.interface";
import type { BookingFinancials } from "./booking-calculation.interface";
import type { CreateBookingInput } from "./dto/create-booking.dto";

@Injectable()
export class BookingPersistenceService {
  constructor(private readonly databaseService: DatabaseService) {}

  async fetchCarWithPricing(carId: string): Promise<CarWithPricing> {
    const car = await this.databaseService.car.findUnique({
      where: { id: carId },
      select: {
        id: true,
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
    await this.databaseService.booking.update({
      where: { id: bookingId },
      data: { paymentStatus: PaymentStatus.UNPAID },
    });
  }

  async createFlightRecordIfNeeded(
    tx: Prisma.TransactionClient,
    booking: CreateBookingInput,
    flightData: FlightDataForBooking | null,
  ): Promise<string | null> {
    if (!flightData || booking.bookingType !== "AIRPORT_PICKUP") {
      return null;
    }

    const flightRecord = await tx.flight.upsert({
      where: { id: flightData.flightId },
      create: {
        id: flightData.flightId,
        flightNumber: flightData.flightNumber.toUpperCase(),
        flightDate: flightData.arrivalTime,
        faFlightId: flightData.flightId,
        originCode: flightData.originCode ?? "UNKNOWN",
        originCodeIATA: flightData.originCodeIATA,
        originName: flightData.originName,
        destinationCode: flightData.destinationCode ?? "DNMM",
        destinationCodeIATA: flightData.destinationIATA,
        destinationName: flightData.destinationName,
        destinationCity: flightData.destinationCity,
        scheduledArrival: flightData.arrivalTime,
        status: FlightStatus.SCHEDULED,
        alertEnabled: false,
      },
      update: {},
      select: { id: true },
    });

    return flightRecord.id;
  }

  async createBookingRecord(
    tx: Prisma.TransactionClient,
    params: {
      bookingReference: string;
      car: CarWithPricing;
      userId: string | null;
      guestUser: { email: string; name: string; phoneNumber: string | null } | null;
      booking: CreateBookingInput;
      financials: BookingFinancials;
      referralEligibility: ReferralEligibility;
      flightRecordId: string | null;
      legs: GeneratedLeg[];
      netPerLeg: Decimal;
      commissionPerLeg: Decimal;
      earningsPerLeg: Decimal;
      platformFleetOwnerCommissionRatePercent: Decimal;
    },
  ): Promise<Booking> {
    const data = this.buildBookingData(params);
    return tx.booking.create({ data });
  }

  private buildBookingData(params: {
    bookingReference: string;
    car: CarWithPricing;
    userId: string | null;
    guestUser: { email: string; name: string; phoneNumber: string | null } | null;
    booking: CreateBookingInput;
    financials: BookingFinancials;
    referralEligibility: ReferralEligibility;
    flightRecordId: string | null;
    legs: GeneratedLeg[];
    netPerLeg: Decimal;
    commissionPerLeg: Decimal;
    earningsPerLeg: Decimal;
    platformFleetOwnerCommissionRatePercent: Decimal;
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
      netPerLeg,
      commissionPerLeg,
      earningsPerLeg,
      platformFleetOwnerCommissionRatePercent,
    } = params;

    if (!financials.numberOfLegs || financials.numberOfLegs === 0) {
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
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupLocation: booking.pickupAddress,
      returnLocation: "dropOffAddress" in booking ? booking.dropOffAddress : booking.pickupAddress,
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
        ? BookingReferralStatus.APPLIED
        : BookingReferralStatus.NONE,
      referralCreditsUsed: financials.creditsUsed,
      referralCreditsReserved: financials.creditsUsed,
      legs: this.buildBookingLegsData({
        legs,
        financials,
        netPerLeg,
        commissionPerLeg,
        earningsPerLeg,
        platformFleetOwnerCommissionRatePercent,
      }),
    };
  }

  private buildBookingLegsData(params: {
    legs: GeneratedLeg[];
    financials: BookingFinancials;
    netPerLeg: Decimal;
    commissionPerLeg: Decimal;
    earningsPerLeg: Decimal;
    platformFleetOwnerCommissionRatePercent: Decimal;
  }) {
    const {
      legs,
      financials,
      netPerLeg,
      commissionPerLeg,
      earningsPerLeg,
      platformFleetOwnerCommissionRatePercent,
    } = params;

    return {
      create: legs.map((leg, index) => ({
        legDate: leg.legDate,
        legStartTime: leg.legStartTime,
        legEndTime: leg.legEndTime,
        totalDailyPrice: financials.legPrices[index].price,
        itemsNetValueForLeg: netPerLeg,
        platformCommissionRateOnLeg: platformFleetOwnerCommissionRatePercent,
        platformCommissionAmountOnLeg: commissionPerLeg,
        fleetOwnerEarningForLeg: earningsPerLeg,
      })),
    };
  }
}
