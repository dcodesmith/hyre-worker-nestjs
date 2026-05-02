import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Booking } from "@prisma/client";
import { Queue } from "bullmq";
import { format } from "date-fns";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { normalizeBookingTimeWindow } from "../../shared/booking-time-window.helper";
import { generateBookingReference } from "../../shared/helper";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { FlightAwareException } from "../flightaware/flightaware.error";
import { FlightAwareService } from "../flightaware/flightaware.service";
import type { FlightAlertJobData } from "../flightaware/flightaware-alert.interface";
import { MapsService } from "../maps/maps.service";
import {
  BookingCreationFailedException,
  BookingException,
  BookingPaymentSyncFailedException,
  PaymentIntentFailedException,
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
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingLegService } from "./booking-leg.service";
import { BookingPaymentService } from "./booking-payment.service";
import { BookingPersistenceService } from "./booking-persistence.service";
import { BookingValidationService } from "./booking-validation.service";
import type { CreateBookingInput, CreateGuestBookingDto } from "./dto/create-booking.dto";
import { isGuestBooking } from "./dto/create-booking.dto";

export type GuestContactSource = "WEB_GUEST_FORM" | "WHATSAPP_AGENT";
export type BookingCreationContext = {
  guestContactSource?: GuestContactSource;
};
export type CreateBookingRequest = {
  input: CreateBookingInput;
  sessionUser: AuthSession["user"] | null;
  context?: BookingCreationContext;
};

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
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly validationService: BookingValidationService,
    private readonly legService: BookingLegService,
    private readonly calculationService: BookingCalculationService,
    private readonly flightAwareService: FlightAwareService,
    private readonly mapsService: MapsService,
    private readonly eligibilityService: BookingEligibilityService,
    private readonly paymentService: BookingPaymentService,
    private readonly persistenceService: BookingPersistenceService,
    private readonly logger: PinoLogger,
    @InjectQueue(FLIGHT_ALERTS_QUEUE)
    private readonly flightAlertQueue: Queue<FlightAlertJobData>,
  ) {
    this.logger.setContext(BookingCreationService.name);
  }

  /**
   * Create a new booking.
   *
   * @param request - Booking input + session metadata + invocation context
   * @returns Booking ID and checkout URL
   * @throws BookingValidationException for validation errors
   * @throws CarNotFoundException if car not found
   * @throws CarNotAvailableException if car is not available
   * @throws FlightAwareException for flight validation errors (from FlightAware module)
   * @throws PaymentIntentFailedException if payment creation fails
   * @throws BookingCreationFailedException for other errors
   */
  async createBooking(request: CreateBookingRequest): Promise<CreateBookingResponse> {
    const { input, sessionUser, context } = request;
    const normalizedBooking = this.normalizeInput(input);
    this.validationService.validateGuestRequirements(normalizedBooking, sessionUser);

    this.logger.info(
      {
        carId: normalizedBooking.carId,
        bookingType: normalizedBooking.bookingType,
        startDate: normalizedBooking.startDate.toISOString(),
        endDate: normalizedBooking.endDate.toISOString(),
        isGuest: isGuestBooking(normalizedBooking),
        userId: sessionUser?.id,
      },
      "Starting booking creation",
    );

    this.validationService.validateDates({
      startDate: normalizedBooking.startDate,
      endDate: normalizedBooking.endDate,
      bookingType: normalizedBooking.bookingType,
    });

    await this.validationService.checkCarAvailability({
      carId: normalizedBooking.carId,
      startDate: normalizedBooking.startDate,
      endDate: normalizedBooking.endDate,
    });

    if (isGuestBooking(normalizedBooking)) {
      await this.validationService.validateGuestEmail(normalizedBooking);
    }

    let flightData: FlightDataForBooking | null = null;

    if (normalizedBooking.bookingType === "AIRPORT_PICKUP" && normalizedBooking.flightNumber) {
      // AIRPORT_PICKUP always has sameLocation=false (enforced by DTO validation)
      // pickupAddress is the airport, dropOffAddress is the customer's destination
      // Type narrowing: when sameLocation is false, dropOffAddress is guaranteed to exist
      if (normalizedBooking.sameLocation === false) {
        flightData = await this.validateAndGetFlightData(
          normalizedBooking.flightNumber,
          normalizedBooking.startDate,
          normalizedBooking.dropOffAddress,
        );
      }
    }

    const car = await this.persistenceService.fetchCarWithPricing(normalizedBooking.carId);

    const legs = this.generateBookingLegs(normalizedBooking, flightData);

    // Preliminary eligibility check for price calculation
    // For authenticated users: check session data for preliminary eligibility
    // Actual eligibility is verified inside the transaction with fresh DB query to prevent race conditions
    const preliminaryReferralEligibility =
      await this.eligibilityService.checkPreliminaryReferralEligibility(sessionUser);

    const financials = await this.calculationService.calculateBookingCost({
      bookingType: normalizedBooking.bookingType,
      legs,
      car,
      includeSecurityDetail: normalizedBooking.includeSecurityDetail,
      requiresFullTank: normalizedBooking.requiresFullTank,
      // Credits not implemented yet - would need to add creditsBalance to User model
      userCreditsBalance: undefined,
      creditsToUse: normalizedBooking.useCredits
        ? new Decimal(normalizedBooking.useCredits)
        : undefined,
      referralDiscountAmount: preliminaryReferralEligibility.discountAmount,
    });

    this.validationService.validatePriceMatch(
      normalizedBooking.clientTotalAmount,
      financials.totalAmount,
    );

    const customerDetails = await this.getCustomerDetails(normalizedBooking, sessionUser);

    const result = await this.createBookingWithPayment({
      booking: normalizedBooking,
      sessionUser,
      context,
      car,
      legs,
      financials,
      customerDetails,
      flightData,
      preliminaryReferralEligibility,
    });

    this.logger.info(
      {
        bookingId: result.bookingId,
      },
      "Booking created successfully",
    );

    return result;
  }

  private normalizeInput(booking: CreateBookingInput): CreateBookingInput {
    const normalizedWindow = normalizeBookingTimeWindow({
      bookingType: booking.bookingType,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupTime: booking.pickupTime,
    });

    return {
      ...booking,
      startDate: normalizedWindow.startDate,
      endDate: normalizedWindow.endDate,
    };
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
   * 3. Compensation: If payment fails, keep booking in UNPAID state and surface payment failure
   *
   * IMPORTANT: Referral eligibility is verified INSIDE the transaction with a fresh DB query
   * and pessimistic locking to prevent race conditions where concurrent requests could
   * all receive the one-time discount.
   */
  private async createBookingWithPayment(params: {
    booking: CreateBookingInput;
    sessionUser: AuthSession["user"] | null;
    context?: BookingCreationContext;
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
      context,
      car,
      legs,
      financials,
      customerDetails,
      flightData,
      preliminaryReferralEligibility,
    } = params;

    const preferredNotificationChannel: "WHATSAPP_ONLY" | "EMAIL_AND_WHATSAPP" | "EMAIL_ONLY" =
      context?.guestContactSource === "WHATSAPP_AGENT"
        ? "WHATSAPP_ONLY"
        : customerDetails.phoneNumber
          ? "EMAIL_AND_WHATSAPP"
          : "EMAIL_ONLY";

    // Build guest user JSON from customerDetails (if guest booking)
    const guestUser = sessionUser
      ? null
      : {
          email: customerDetails.email,
          name: customerDetails.name,
          phoneNumber: customerDetails.phoneNumber ?? null,
          guestContactSource: context?.guestContactSource ?? "WEB_GUEST_FORM",
          preferredNotificationChannel,
        };

    // Track flight record ID for post-transaction alert creation
    let flightRecordIdForAlert: string | null = null;

    let createdBooking: Booking;
    let finalizedFinancials = financials;

    const bookingReference = generateBookingReference();

    try {
      createdBooking = await this.databaseService.$transaction(async (tx) => {
        // CRITICAL: Verify and claim referral discount FIRST with pessimistic locking
        // This prevents race conditions where concurrent requests could all receive the one-time discount
        const verifiedReferralEligibility = sessionUser
          ? await this.eligibilityService.verifyAndClaimReferralDiscountInTransaction(
              tx,
              sessionUser.id,
              preliminaryReferralEligibility,
            )
          : preliminaryReferralEligibility;

        const recalculatedFinancials = await this.calculationService.calculateBookingCost({
          bookingType: booking.bookingType,
          legs,
          car,
          includeSecurityDetail: booking.includeSecurityDetail,
          requiresFullTank: booking.requiresFullTank,
          userCreditsBalance: undefined,
          creditsToUse: booking.useCredits ? new Decimal(booking.useCredits) : undefined,
          referralDiscountAmount: verifiedReferralEligibility.discountAmount,
        });

        const referralEligibilityChanged =
          verifiedReferralEligibility.eligible !== preliminaryReferralEligibility.eligible ||
          verifiedReferralEligibility.referrerUserId !==
            preliminaryReferralEligibility.referrerUserId ||
          !verifiedReferralEligibility.discountAmount.eq(
            preliminaryReferralEligibility.discountAmount,
          );

        if (referralEligibilityChanged) {
          this.logger.warn(
            {
              bookingReference,
              userId: sessionUser?.id,
              previousDiscountAmount: preliminaryReferralEligibility.discountAmount.toString(),
              updatedDiscountAmount: verifiedReferralEligibility.discountAmount.toString(),
            },
            "Referral eligibility changed during booking transaction",
          );
          throw new BookingCreationFailedException(
            "Referral eligibility changed during booking creation. Please retry.",
          );
        }

        this.validationService.validatePriceMatch(
          booking.clientTotalAmount,
          recalculatedFinancials.totalAmount,
        );
        finalizedFinancials = recalculatedFinancials;

        const flightRecordId = await this.persistenceService.createFlightRecordIfNeeded(
          tx,
          booking,
          flightData,
        );

        flightRecordIdForAlert = flightRecordId;

        const bookingRecord = await this.persistenceService.createBookingRecord(tx, {
          bookingReference,
          car,
          userId: sessionUser?.id ?? null,
          guestUser,
          booking,
          financials: finalizedFinancials,
          referralEligibility: verifiedReferralEligibility,
          flightRecordId,
          legs,
        });

        // Create referral reward record (the discount was already claimed above)
        await this.eligibilityService.createReferralRewardIfEligible(
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

      this.logger.error(
        {
          bookingReference,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Booking creation transaction failed",
      );

      throw new BookingCreationFailedException();
    }

    let checkoutUrl: string;

    try {
      const paymentResult = await this.paymentService.createPaymentIntent(
        createdBooking,
        finalizedFinancials,
        customerDetails,
        booking.callbackUrl,
      );
      checkoutUrl = paymentResult.checkoutUrl;
      await this.syncPaymentIntentWithBooking(createdBooking.id, paymentResult.paymentIntentId);
    } catch (error) {
      if (error instanceof BookingPaymentSyncFailedException) {
        throw error;
      }

      if (error instanceof BookingCreationFailedException) {
        throw error;
      }

      await this.handlePaymentFailureCompensation(createdBooking, error);

      // Re-throw payment exception
      if (error instanceof PaymentIntentFailedException) {
        throw error;
      }
      throw new PaymentIntentFailedException();
    }

    await this.queueFlightAlertIfNeeded(flightRecordIdForAlert, booking, flightData);

    return {
      bookingId: createdBooking.id,
      checkoutUrl,
    };
  }

  private async handlePaymentFailureCompensation(booking: Booking, originalError: unknown) {
    // Step 3: Compensation - keep booking in unpaid state if payment creation fails
    this.logger.warn(
      {
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
      },
      "Payment intent failed, keeping booking in UNPAID state",
    );

    try {
      await this.persistenceService.markBookingUnpaid(booking.id);
    } catch (markUnpaidError) {
      this.logger.error(
        {
          bookingId: booking.id,
          bookingReference: booking.bookingReference,
          error:
            markUnpaidError instanceof Error ? markUnpaidError.message : String(markUnpaidError),
          originalPaymentError:
            originalError instanceof Error ? originalError.message : String(originalError),
        },
        "Failed to mark booking as UNPAID after payment failure",
      );

      throw new BookingCreationFailedException(
        "Payment failed and compensation failed to mark booking as UNPAID.",
      );
    }
  }

  private async syncPaymentIntentWithBooking(
    bookingId: string,
    paymentIntentId: string,
  ): Promise<void> {
    try {
      await this.databaseService.booking.update({
        where: { id: bookingId },
        data: { paymentIntent: paymentIntentId },
      });
    } catch (updateError) {
      this.logger.error(
        {
          bookingId,
          paymentIntentId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        },
        "Payment created but booking update failed; manual reconciliation required",
      );
      throw new BookingPaymentSyncFailedException();
    }
  }

  /**
   * Queue flight alert creation if this is an airport pickup.
   */
  private async queueFlightAlertIfNeeded(
    flightRecordId: string | null,
    booking: CreateBookingInput,
    flightData: FlightDataForBooking | null,
  ): Promise<void> {
    if (!flightRecordId || !flightData || booking.bookingType !== "AIRPORT_PICKUP") {
      return;
    }

    try {
      const jobData: FlightAlertJobData = {
        flightId: flightRecordId,
        flightNumber: flightData.flightNumber,
        flightDate: flightData.arrivalTime.toISOString(),
        destinationIATA: flightData.destinationIATA,
      };

      await this.flightAlertQueue.add(CREATE_FLIGHT_ALERT_JOB, jobData, {
        jobId: `flight-alert-${flightRecordId}`,
      });

      this.logger.info(
        {
          flightId: flightRecordId,
          flightNumber: flightData.flightNumber,
        },
        "Queued flight alert creation",
      );
    } catch (error) {
      this.logger.error(
        {
          flightId: flightRecordId,
          flightNumber: flightData.flightNumber,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to queue flight alert creation",
      );
    }
  }
}
