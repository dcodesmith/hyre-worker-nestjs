import { Injectable, Logger } from "@nestjs/common";
import {
  Booking,
  BookingReferralStatus,
  BookingStatus,
  FlightStatus,
  PaymentStatus,
  ReferralReleaseCondition,
  ReferralRewardStatus,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { format } from "date-fns";
import { generateBookingReference } from "../../shared/helper";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { FlightAwareException } from "../flightaware/flightaware.error";
import { FlightAwareService } from "../flightaware/flightaware.service";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MapsService } from "../maps/maps.service";
import {
  BookingCreationFailedException,
  BookingException,
  BookingValidationException,
  CarNotFoundException,
  PaymentIntentFailedException,
  ReferralDiscountNoLongerAvailableException,
} from "./booking.error";
import type {
  CarWithPricing,
  CreateBookingResponse,
  CustomerDetails,
  FlightDataForBooking,
  GeneratedLeg,
  LegGenerationInput,
  ReferralEligibility,
} from "./booking.interface";
import type { BookingFinancials } from "./booking-calculation.interface";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingValidationService } from "./booking-validation.service";
import type { CreateBookingInput, CreateGuestBookingDto } from "./dto/create-booking.dto";
import { isGuestBooking } from "./dto/create-booking.dto";

/**
 * Service for orchestrating the complete booking creation flow.
 *
 * This service handles:
 * - Validation (dates, availability, guest email, flight)
 * - Leg generation
 * - Financial calculations
 * - Payment intent creation
 * - Booking record creation
 * - Flight alert setup (for airport pickups)
 * - Referral handling
 */
@Injectable()
export class BookingCreationService {
  private readonly logger = new Logger(BookingCreationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly validationService: BookingValidationService,
    private readonly legService: BookingLegService,
    private readonly calculationService: BookingCalculationService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly flightAwareService: FlightAwareService,
    private readonly mapsService: MapsService,
  ) {}

  /**
   * Create a new booking.
   *
   * @param booking - Validated booking DTO from request body
   * @param sessionUser - Authenticated user from session (null for guest bookings)
   * @returns Booking ID and checkout URL
   * @throws BookingValidationException for validation errors
   * @throws CarNotFoundException if car not found
   * @throws CarNotAvailableException if car is not available
   * @throws FlightAwareException for flight validation errors (from FlightAware module)
   * @throws PaymentIntentFailedException if payment creation fails
   * @throws BookingCreationFailedException for other errors
   */
  async createBooking(
    booking: CreateBookingInput,
    sessionUser: AuthSession["user"] | null,
  ): Promise<CreateBookingResponse> {
    // Validate guest booking requirements early
    if (!sessionUser && !isGuestBooking(booking)) {
      throw new BookingValidationException(
        [
          { field: "guestEmail", message: "Guest email is required for unauthenticated bookings" },
          { field: "guestName", message: "Guest name is required for unauthenticated bookings" },
          { field: "guestPhone", message: "Guest phone is required for unauthenticated bookings" },
        ],
        "Guest information is required when booking without authentication",
      );
    }

    this.logger.log("Starting booking creation", {
      carId: booking.carId,
      bookingType: booking.bookingType,
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      isGuest: isGuestBooking(booking),
      userId: sessionUser?.id,
    });

    this.validationService.validateDates({
      startDate: booking.startDate,
      endDate: booking.endDate,
      bookingType: booking.bookingType,
    });

    await this.validationService.checkCarAvailability({
      carId: booking.carId,
      startDate: booking.startDate,
      endDate: booking.endDate,
    });

    if (isGuestBooking(booking)) {
      await this.validationService.validateGuestEmail(booking);
    }

    let flightData: FlightDataForBooking | null = null;

    if (booking.bookingType === "AIRPORT_PICKUP" && booking.flightNumber) {
      // AIRPORT_PICKUP always has sameLocation=false (enforced by DTO validation)
      // pickupAddress is the airport, dropOffAddress is the customer's destination
      // Type narrowing: when sameLocation is false, dropOffAddress is guaranteed to exist
      if (booking.sameLocation === false) {
        flightData = await this.validateAndGetFlightData(
          booking.flightNumber,
          booking.startDate,
          booking.dropOffAddress,
        );
      }
    }

    const car = await this.fetchCarWithPricing(booking.carId);

    const legs = this.generateBookingLegs(booking, flightData);

    // Preliminary eligibility check for price calculation
    // For authenticated users: check session data for preliminary eligibility
    // Actual eligibility is verified inside the transaction with fresh DB query to prevent race conditions
    const preliminaryReferralEligibility =
      await this.checkPreliminaryReferralEligibility(sessionUser);

    const financials = await this.calculationService.calculateBookingCost({
      bookingType: booking.bookingType,
      legs,
      car,
      includeSecurityDetail: booking.includeSecurityDetail,
      requiresFullTank: booking.requiresFullTank,
      // Credits not implemented yet - would need to add creditsBalance to User model
      userCreditsBalance: undefined,
      creditsToUse: booking.useCredits ? new Decimal(booking.useCredits) : undefined,
      referralDiscountAmount: preliminaryReferralEligibility.discountAmount,
    });

    this.validationService.validatePriceMatch(booking.clientTotalAmount, financials.totalAmount);

    const customerDetails = await this.getCustomerDetails(booking, sessionUser);

    const result = await this.createBookingWithPayment({
      booking,
      sessionUser,
      car,
      legs,
      financials,
      customerDetails,
      flightData,
      preliminaryReferralEligibility,
    });

    this.logger.log("Booking created successfully", {
      bookingId: result.bookingId,
    });

    return result;
  }

  /**
   * Validate flight and get flight data for airport pickup bookings.
   * FlightAwareService throws FlightAwareException if validation fails.
   */
  private async validateAndGetFlightData(
    flightNumber: string,
    pickupDate: Date,
    dropOffAddress: string,
  ): Promise<FlightDataForBooking> {
    const pickupDateStr = format(pickupDate, "yyyy-MM-dd");

    // FlightAwareService now throws FlightAwareException on validation errors
    const flight = await this.flightAwareService.validateFlight(flightNumber, pickupDateStr);

    // Calculate drive time if we have the drop-off address
    let driveTimeMinutes: number | undefined;
    if (dropOffAddress) {
      const driveTimeResult = await this.mapsService.calculateAirportTripDuration(dropOffAddress);
      driveTimeMinutes = driveTimeResult.durationMinutes;
    }

    // Get the best arrival time
    const arrivalTimeStr =
      flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival;
    const arrivalTime = new Date(arrivalTimeStr);

    return {
      flightId: flight.flightId,
      arrivalTime,
      flightNumber: flight.flightNumber,
      originCode: flight.origin,
      originCodeIATA: flight.originIATA,
      originName: flight.originName,
      destinationCode: flight.destination,
      destinationIATA: flight.destinationIATA,
      destinationName: flight.destinationName,
      destinationCity: flight.destinationCity,
      driveTimeMinutes,
    };
  }

  /**
   * Fetch car with pricing information.
   */
  private async fetchCarWithPricing(carId: string): Promise<CarWithPricing> {
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

  /**
   * Generate booking legs based on booking type.
   */
  private generateBookingLegs(
    booking: CreateBookingInput,
    flightData: FlightDataForBooking | null,
  ): GeneratedLeg[] {
    const { bookingType, startDate, endDate } = booking;

    let legInput: LegGenerationInput;

    switch (bookingType) {
      case "DAY":
        legInput = {
          bookingType: "DAY",
          startDate,
          endDate,
          pickupTime: booking.pickupTime,
        };
        break;

      case "NIGHT":
        legInput = {
          bookingType: "NIGHT",
          startDate,
          endDate,
        };
        break;

      case "FULL_DAY":
        legInput = {
          bookingType: "FULL_DAY",
          startDate,
          endDate,
          pickupTime: booking.pickupTime,
        };
        break;

      case "AIRPORT_PICKUP":
        legInput = {
          bookingType: "AIRPORT_PICKUP",
          startDate,
          endDate,
          flightArrivalTime: flightData?.arrivalTime,
          driveTimeMinutes: flightData?.driveTimeMinutes,
        };
        break;

      default: {
        const exhaustiveCheck: never = bookingType;
        throw new Error(`Unknown booking type: ${exhaustiveCheck}`);
      }
    }

    return this.legService.generateLegs(legInput);
  }

  /**
   * Preliminary check for referral discount eligibility.
   *
   * IMPORTANT: This is a preliminary check for pre-transaction price calculation.
   * We query the database to get fresh referral status (not in session).
   * The actual eligibility is verified AGAIN inside the transaction with pessimistic
   * locking to prevent race conditions where the discount could be used concurrently.
   *
   * This preliminary check ensures users see the correct price upfront, avoiding
   * surprise errors at checkout if their discount was already used.
   *
   * @see verifyAndClaimReferralDiscountInTransaction for the transaction-safe verification
   */
  private async checkPreliminaryReferralEligibility(
    sessionUser: AuthSession["user"] | null,
  ): Promise<ReferralEligibility> {
    // Guest users are not eligible for referral discounts
    if (!sessionUser) {
      return { eligible: false, referrerUserId: null, discountAmount: new Decimal(0) };
    }

    // Fetch referral fields from database (not in session)
    // This is a lightweight query to check current referral status
    const user = await this.databaseService.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        referredByUserId: true,
        referralDiscountUsed: true,
      },
    });

    // Not eligible if: no referrer OR discount already used
    if (!user?.referredByUserId || user.referralDiscountUsed) {
      return { eligible: false, referrerUserId: null, discountAmount: new Decimal(0) };
    }

    // Get referral program config (safe to read outside transaction)
    // Note: Transaction will verify eligibility again with FOR UPDATE lock
    return this.getReferralConfig(user.referredByUserId);
  }

  /**
   * Get referral program configuration.
   * Returns eligibility based on config settings only.
   */
  private async getReferralConfig(referrerUserId: string): Promise<ReferralEligibility> {
    const configs = await this.databaseService.referralProgramConfig.findMany({
      where: { key: { in: ["REFERRAL_ENABLED", "REFERRAL_DISCOUNT_AMOUNT"] } },
    });

    const configMap = configs.reduce<Record<string, unknown>>((acc, c) => {
      acc[c.key] = c.value;
      return acc;
    }, {});

    // Validate and normalize REFERRAL_ENABLED to boolean
    const rawEnabled = configMap.REFERRAL_ENABLED;
    let isEnabled: boolean;
    if (typeof rawEnabled === "boolean") {
      isEnabled = rawEnabled;
    } else if (typeof rawEnabled === "string") {
      isEnabled = rawEnabled.toLowerCase() === "true";
    } else {
      // Default to true if not set or invalid type
      isEnabled = rawEnabled === undefined || rawEnabled === null;
    }

    // Validate and normalize REFERRAL_DISCOUNT_AMOUNT to Decimal
    const rawDiscountAmount = configMap.REFERRAL_DISCOUNT_AMOUNT;
    let discountAmount: Decimal;
    if (rawDiscountAmount === undefined || rawDiscountAmount === null) {
      discountAmount = new Decimal(0);
    } else if (typeof rawDiscountAmount === "number") {
      discountAmount = new Decimal(rawDiscountAmount);
    } else if (typeof rawDiscountAmount === "string") {
      const parsed = Number(rawDiscountAmount);
      discountAmount = Number.isNaN(parsed) ? new Decimal(0) : new Decimal(parsed);
    } else {
      // Invalid type (object, array, etc.) - fallback to 0
      this.logger.warn("Invalid REFERRAL_DISCOUNT_AMOUNT config value type", {
        type: typeof rawDiscountAmount,
        value: rawDiscountAmount,
      });
      discountAmount = new Decimal(0);
    }

    if (!isEnabled || discountAmount.lte(0)) {
      return { eligible: false, referrerUserId: null, discountAmount: new Decimal(0) };
    }

    return {
      eligible: true,
      referrerUserId,
      discountAmount,
    };
  }

  /**
   * Verify and claim the referral discount inside a transaction.
   *
   * This method queries fresh user data from the database to check if the discount
   * is still available, then immediately marks it as used to prevent race conditions.
   *
   * @param tx - Prisma transaction client
   * @param userId - User ID to verify eligibility for
   * @param preliminaryEligibility - The preliminary eligibility from pre-transaction check
   * @returns The verified referral eligibility
   * @throws ReferralDiscountNoLongerAvailableException if preliminary check was eligible but discount was already used
   */
  private async verifyAndClaimReferralDiscountInTransaction(
    tx: Parameters<Parameters<typeof this.databaseService.$transaction>[0]>[0],
    userId: string,
    preliminaryEligibility: ReferralEligibility,
  ): Promise<ReferralEligibility> {
    // If preliminary check said not eligible, no need to verify
    if (!preliminaryEligibility.eligible) {
      return preliminaryEligibility;
    }

    // Query fresh user data with pessimistic lock to prevent concurrent modifications
    // Using a raw query with FOR UPDATE to ensure we have an exclusive lock on the row
    const users = await tx.$queryRaw<
      Array<{ id: string; referredByUserId: string | null; referralDiscountUsed: boolean }>
    >`SELECT id, "referredByUserId", "referralDiscountUsed" FROM "User" WHERE id = ${userId} FOR UPDATE`;

    const freshUser = users[0];

    if (!freshUser) {
      this.logger.warn("User not found during referral verification", { userId });
      return { eligible: false, referrerUserId: null, discountAmount: new Decimal(0) };
    }

    // Check if discount was already used (by a concurrent request)
    if (freshUser.referralDiscountUsed) {
      this.logger.warn("Referral discount already used (race condition detected)", {
        userId,
        preliminaryEligible: preliminaryEligibility.eligible,
      });

      // The preliminary check thought we were eligible, but the discount was already used
      // This is a race condition - throw an error so the client can retry without the discount
      throw new ReferralDiscountNoLongerAvailableException();
    }

    // Check if user still has a referrer (edge case: referrer could be removed)
    if (!freshUser.referredByUserId) {
      this.logger.warn("User no longer has a referrer", { userId });
      return { eligible: false, referrerUserId: null, discountAmount: new Decimal(0) };
    }

    // Mark discount as used IMMEDIATELY (before booking creation) to prevent race conditions
    await tx.user.update({
      where: { id: userId },
      data: { referralDiscountUsed: true },
    });

    this.logger.log("Referral discount claimed and marked as used", { userId });

    return preliminaryEligibility;
  }

  /**
   * Get customer details for payment intent.
   * Uses session user data for authenticated users, or guest booking fields for guests.
   */
  private async getCustomerDetails(
    booking: CreateBookingInput,
    sessionUser: AuthSession["user"] | null,
  ): Promise<CustomerDetails> {
    if (sessionUser) {
      // Fetch phone number from database (not in session)
      const user = await this.databaseService.user.findUnique({
        where: { id: sessionUser.id },
        select: { phoneNumber: true, email: true, name: true },
      });

      if (!user) {
        throw new BookingCreationFailedException("User not found for session");
      }

      return user;
    }

    const guestBooking = booking as CreateGuestBookingDto;

    return {
      email: guestBooking.guestEmail,
      name: guestBooking.guestName,
      phoneNumber: guestBooking.guestPhone,
    };
  }

  /**
   * Create the booking record with payment intent.
   *
   * This method separates DB operations from external HTTP calls:
   * 1. Transaction: Verify referral eligibility, create booking record, flight record, and referral reward
   * 2. After commit: Create payment intent (external HTTP call)
   * 3. Compensation: If payment fails, update booking status to FAILED
   *
   * IMPORTANT: Referral eligibility is verified INSIDE the transaction with a fresh DB query
   * and pessimistic locking to prevent race conditions where concurrent requests could
   * all receive the one-time discount.
   */
  private async createBookingWithPayment(params: {
    booking: CreateBookingInput;
    sessionUser: AuthSession["user"] | null;
    car: CarWithPricing;
    legs: GeneratedLeg[];
    financials: BookingFinancials;
    customerDetails: CustomerDetails;
    flightData: FlightDataForBooking | null;
    preliminaryReferralEligibility: ReferralEligibility;
  }): Promise<CreateBookingResponse> {
    const {
      booking,
      sessionUser,
      car,
      legs,
      financials,
      customerDetails,
      flightData,
      preliminaryReferralEligibility,
    } = params;

    // Build guest user JSON from customerDetails (if guest booking)
    const guestUser = sessionUser
      ? null
      : {
          email: customerDetails.email,
          name: customerDetails.name,
          phoneNumber: customerDetails.phoneNumber ?? null,
        };

    // Calculate leg-level financial data
    const {
      platformFleetOwnerCommissionRatePercent,
      platformFleetOwnerCommissionAmount,
      netTotal,
    } = financials;
    const numberOfLegs = financials.numberOfLegs;

    // Guard against division by zero
    if (!numberOfLegs || numberOfLegs === 0) {
      throw new BookingCreationFailedException(
        "Cannot create booking: number of legs must be greater than zero",
      );
    }

    // Each leg gets proportional commission and earnings
    const commissionPerLeg = platformFleetOwnerCommissionAmount.div(numberOfLegs);
    const netPerLeg = netTotal.div(numberOfLegs);
    const earningsPerLeg = netPerLeg.sub(commissionPerLeg);

    // Track flight record ID for post-transaction alert creation
    let flightRecordIdForAlert: string | null = null;

    let createdBooking: Booking;

    const bookingReference = generateBookingReference();

    try {
      createdBooking = await this.databaseService.$transaction(async (tx) => {
        // CRITICAL: Verify and claim referral discount FIRST with pessimistic locking
        // This prevents race conditions where concurrent requests could all receive the one-time discount
        const verifiedReferralEligibility = sessionUser
          ? await this.verifyAndClaimReferralDiscountInTransaction(
              tx,
              sessionUser.id,
              preliminaryReferralEligibility,
            )
          : preliminaryReferralEligibility;

        const flightRecordId = await this.createFlightRecordIfNeeded(tx, booking, flightData);

        flightRecordIdForAlert = flightRecordId;

        const bookingData = this.buildBookingData({
          bookingReference,
          car,
          userId: sessionUser?.id ?? null,
          guestUser,
          booking,
          financials,
          referralEligibility: verifiedReferralEligibility,
          flightRecordId,
          legs,
          netPerLeg,
          commissionPerLeg,
          earningsPerLeg,
          platformFleetOwnerCommissionRatePercent,
        });

        const bookingRecord = await tx.booking.create({
          data: bookingData,
        });

        // Create referral reward record (the discount was already claimed above)
        await this.createReferralRewardIfEligible(
          tx,
          bookingRecord.id,
          verifiedReferralEligibility,
          sessionUser?.id ?? null,
        );

        return bookingRecord;
      });
    } catch (error) {
      // Re-throw domain-specific exceptions (includes ReferralDiscountNoLongerAvailableException)
      if (error instanceof BookingException || error instanceof FlightAwareException) {
        throw error;
      }

      this.logger.error("Booking creation transaction failed", {
        bookingReference,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw new BookingCreationFailedException();
    }

    let checkoutUrl: string;

    try {
      checkoutUrl = await this.createPaymentIntent(createdBooking, financials, customerDetails);
    } catch (error) {
      // Step 3: Compensation - mark booking as failed if payment creation fails
      this.logger.warn("Payment intent failed, marking booking as failed", {
        bookingId: createdBooking.id,
        bookingReference: createdBooking.bookingReference,
      });

      await this.databaseService.booking.update({
        where: { id: createdBooking.id },
        // change to fail in fast follow PR
        data: { paymentStatus: PaymentStatus.UNPAID },
      });

      // Re-throw payment exception
      if (error instanceof PaymentIntentFailedException) {
        throw error;
      }
      throw new PaymentIntentFailedException();
    }

    this.triggerFlightAlertIfNeeded(flightRecordIdForAlert, booking, flightData);

    return {
      bookingId: createdBooking.id,
      checkoutUrl,
    };
  }

  /**
   * Create flight record if this is an airport pickup booking.
   */
  private async createFlightRecordIfNeeded(
    tx: Parameters<Parameters<typeof this.databaseService.$transaction>[0]>[0],
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

  /**
   * Build booking data object for Prisma create.
   */
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
      // Financial data
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
      // Referral data
      referralReferrerUserId: referralEligibility.eligible
        ? referralEligibility.referrerUserId
        : null,
      referralDiscountAmount: referralEligibility.discountAmount,
      referralStatus: referralEligibility.eligible
        ? BookingReferralStatus.APPLIED
        : BookingReferralStatus.NONE,
      referralCreditsUsed: financials.creditsUsed,
      referralCreditsReserved: financials.creditsUsed,
      // Booking legs
      legs: {
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
      },
    };
  }

  /**
   * Create referral reward record if user is eligible.
   *
   * Note: The referralDiscountUsed flag is set earlier in verifyAndClaimReferralDiscountInTransaction
   * to prevent race conditions. This method only creates the referral reward record.
   */
  private async createReferralRewardIfEligible(
    tx: Parameters<Parameters<typeof this.databaseService.$transaction>[0]>[0],
    bookingId: string,
    referralEligibility: ReferralEligibility,
    userId: string | null,
  ): Promise<void> {
    if (!referralEligibility.eligible || !referralEligibility.referrerUserId || !userId) {
      return;
    }

    // Note: referralDiscountUsed was already set to true in verifyAndClaimReferralDiscountInTransaction
    // to prevent race conditions. We don't set it again here.

    // Get referral reward amount and release condition from config
    const rewardConfigs = await tx.referralProgramConfig.findMany({
      where: { key: { in: ["REFERRAL_REWARD_AMOUNT", "REFERRAL_RELEASE_CONDITION"] } },
    });

    const rewardConfigMap = rewardConfigs.reduce<Record<string, unknown>>((acc, c) => {
      acc[c.key] = c.value;
      return acc;
    }, {});

    const rewardAmount = new Decimal(String(rewardConfigMap.REFERRAL_REWARD_AMOUNT ?? 0));
    if (!rewardAmount.gt(0)) {
      return;
    }

    const releaseCondition =
      (rewardConfigMap.REFERRAL_RELEASE_CONDITION as string) === "PAID"
        ? ReferralReleaseCondition.PAID
        : ReferralReleaseCondition.COMPLETED;

    await tx.referralReward.create({
      data: {
        referrer: { connect: { id: referralEligibility.referrerUserId } },
        referee: { connect: { id: userId } },
        booking: { connect: { id: bookingId } },
        amount: rewardAmount,
        status: ReferralRewardStatus.PENDING,
        releaseCondition,
      },
    });

    // Update referrer's pending rewards stats
    await tx.userReferralStats.upsert({
      where: { userId: referralEligibility.referrerUserId },
      create: {
        userId: referralEligibility.referrerUserId,
        totalReferrals: 0,
        totalRewardsGranted: 0,
        totalRewardsPending: rewardAmount,
      },
      update: {
        totalRewardsPending: { increment: rewardAmount },
      },
    });

    this.logger.log("Created pending referral reward", {
      bookingId,
      referrerUserId: referralEligibility.referrerUserId,
      rewardAmount: rewardAmount.toString(),
    });
  }

  /**
   * Trigger flight alert creation if this is an airport pickup.
   */
  private triggerFlightAlertIfNeeded(
    flightRecordId: string | null,
    booking: CreateBookingInput,
    flightData: FlightDataForBooking | null,
  ): void {
    if (!flightRecordId || !flightData || booking.bookingType !== "AIRPORT_PICKUP") {
      return;
    }

    // Fire and forget - don't block booking creation
    this.createFlightAlertAsync(
      flightRecordId,
      flightData.flightNumber,
      flightData.arrivalTime,
      flightData.destinationIATA,
    );
  }

  /**
   * Create payment intent and update booking with payment intent ID.
   * Called after the booking transaction commits.
   */
  private async createPaymentIntent(
    createdBooking: { id: string; bookingReference: string },
    financials: BookingFinancials,
    customerDetails: CustomerDetails,
  ): Promise<string> {
    const callbackUrl = this.flutterwaveService.getWebhookUrl("/api/payments/callback");

    try {
      const paymentResult = await this.flutterwaveService.createPaymentIntent({
        amount: financials.totalAmount.toNumber(),
        customer: {
          email: customerDetails.email,
          name: customerDetails.name,
          phoneNumber: customerDetails.phoneNumber,
        },
        metadata: {
          bookingId: createdBooking.id,
          bookingReference: createdBooking.bookingReference,
          type: "booking_creation",
        },
        callbackUrl,
        transactionType: "booking_creation",
        idempotencyKey: createdBooking.id,
      });

      // Update booking with payment intent ID (outside transaction)
      await this.databaseService.booking.update({
        where: { id: createdBooking.id },
        data: { paymentIntent: paymentResult.paymentIntentId },
      });

      return paymentResult.checkoutUrl;
    } catch (error) {
      this.logger.error("Payment intent creation failed", {
        bookingId: createdBooking.id,
        bookingReference: createdBooking.bookingReference,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof FlutterwaveError) {
        throw new PaymentIntentFailedException(error.message);
      }
      throw new PaymentIntentFailedException();
    }
  }

  /**
   * Create flight alert asynchronously (fire and forget).
   * This doesn't block booking creation.
   */
  private createFlightAlertAsync(
    flightId: string,
    flightNumber: string,
    arrivalDate: Date,
    destinationIATA: string | undefined,
  ): void {
    // Fire and forget - don't await
    this.flightAwareService
      .getOrCreateFlightAlert(flightId, {
        flightNumber,
        flightDate: arrivalDate,
        destinationIATA,
      })
      .then((alertId) => {
        this.logger.log("Flight alert created", { flightId, alertId });
      })
      .catch((error) => {
        this.logger.warn("Failed to create flight alert", {
          flightId,
          flightNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
