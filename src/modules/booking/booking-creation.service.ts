import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Booking, Prisma } from "@prisma/client";
import { format } from "date-fns";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../config/env.config";
import { normalizeBookingTimeWindow } from "../../shared/booking-time-window.helper";
import { generateBookingReference } from "../../shared/helper";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService, lockCarRow } from "../database/database.service";
import { FlightAwareApiException, FlightAwareException } from "../flightaware/flightaware.error";
import { FlightAwareService } from "../flightaware/flightaware.service";
import { MapsService } from "../maps/maps.service";
import {
  BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS,
  BOOKING_PAYMENT_SESSION_DURATION_MS,
} from "./booking.const";
import {
  BookingCreationFailedException,
  BookingException,
  BookingPaymentSyncFailedException,
  BookingRequestInProgressException,
  CarNotAvailableException,
  PaymentIntentFailedException,
} from "./booking.error";
import type {
  CarWithPricing,
  CreateBookingResponse,
  CustomerDetails,
  FlightDataForBooking,
  GeneratedLeg,
  ReferralEligibility,
} from "./booking.interface";
import type { BookingFinancials } from "./booking-calculation.interface";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingCreationIdempotencyService } from "./booking-creation-idempotency.service";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingLegService } from "./booking-leg.service";
import { buildLegGenerationInput } from "./booking-leg-input.builder";
import { BookingPaymentService } from "./booking-payment.service";
import { createBookingPaymentStatusToken } from "./booking-payment-status-token.helper";
import { BookingPersistenceService } from "./booking-persistence.service";
import { BookingReservationService } from "./booking-reservation.service";
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
  idempotencyKey: string;
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
    private readonly reservationService: BookingReservationService,
    private readonly idempotencyService: BookingCreationIdempotencyService,
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly logger: PinoLogger,
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
    const { input, sessionUser, idempotencyKey, context } = request;
    const normalizedBooking = this.normalizeInput(input);
    this.validationService.validateGuestRequirements(normalizedBooking, sessionUser);
    const customerScope = this.idempotencyService.getCustomerScope(normalizedBooking, sessionUser);
    const requestHash = this.idempotencyService.createRequestHash(
      normalizedBooking,
      context ? { guestContactSource: context.guestContactSource } : undefined,
    );
    const claim = await this.idempotencyService.claim(customerScope, idempotencyKey, requestHash);
    if (claim.kind === "replay") {
      return claim.response;
    }
    if (claim.kind === "resume") {
      return this.resumeBookingPayment(claim.id, claim.bookingId, normalizedBooking, sessionUser);
    }

    try {
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
        if (normalizedBooking.sameLocation === false) {
          flightData = await this.validateAndGetFlightData(
            normalizedBooking.flightNumber,
            normalizedBooking.startDate,
            normalizedBooking.dropOffAddress,
          );
        }
      }

      const car = await this.persistenceService.fetchCarWithPricing(normalizedBooking.carId);
      const legs = this.legService.generateLegs(
        buildLegGenerationInput({
          bookingType: normalizedBooking.bookingType,
          startDate: normalizedBooking.startDate,
          endDate: normalizedBooking.endDate,
          pickupTime: normalizedBooking.pickupTime,
          flightArrivalTime: flightData?.arrivalTime,
          driveTimeMinutes: flightData?.driveTimeMinutes,
        }),
      );
      const baseFinancials = await this.calculateFinancials(
        normalizedBooking,
        car,
        legs,
        new Decimal(0),
      );
      const preliminaryReferralEligibility =
        await this.eligibilityService.checkReferralEligibilityForPricing(
          sessionUser,
          baseFinancials.subtotalBeforeDiscounts,
          normalizedBooking.bookingType,
        );
      const financials = preliminaryReferralEligibility.discountAmount.gt(0)
        ? await this.calculateFinancials(
            normalizedBooking,
            car,
            legs,
            preliminaryReferralEligibility.discountAmount,
          )
        : baseFinancials;

      this.validationService.validateExpectedPrice(
        normalizedBooking.expectedTotalAmount,
        financials,
      );
      const customerDetails = await this.getCustomerDetails(normalizedBooking, sessionUser);
      const result = await this.createBookingWithPayment({
        idempotencyId: claim.id,
        booking: normalizedBooking,
        sessionUser,
        context,
        legs,
        financials,
        customerDetails,
        flightData,
        preliminaryReferralEligibility,
      });

      this.logger.info({ bookingId: result.bookingId }, "Booking created successfully");
      return result;
    } catch (error) {
      await this.releaseIdempotencyClaim(claim.id);
      throw error;
    }
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

  private calculateFinancials(
    booking: CreateBookingInput,
    car: CarWithPricing,
    legs: GeneratedLeg[],
    referralDiscountAmount: Decimal,
    tx?: Prisma.TransactionClient,
  ): Promise<BookingFinancials> {
    return this.calculationService.calculateBookingCost(
      {
        bookingType: booking.bookingType,
        legs,
        car,
        includeSecurityDetail: booking.includeSecurityDetail,
        requiresFullTank: booking.requiresFullTank,
        userCreditsBalance: undefined,
        creditsToUse: booking.useCredits ? new Decimal(booking.useCredits) : undefined,
        referralDiscountAmount,
      },
      tx,
    );
  }

  private async resumeBookingPayment(
    idempotencyId: string,
    bookingId: string,
    bookingInput: CreateBookingInput,
    sessionUser: AuthSession["user"] | null,
  ): Promise<CreateBookingResponse> {
    const booking = await this.databaseService.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      throw new BookingCreationFailedException("Idempotent booking could not be recovered.");
    }
    if (booking.paymentIntent) {
      // The marker is persisted before calling Flutterwave. With no checkpointed
      // response, the provider outcome is uncertain, so retrying could create a
      // second checkout. Keep the reservation and let reconciliation resolve it.
      throw new BookingRequestInProgressException(BOOKING_IDEMPOTENCY_RETRY_AFTER_SECONDS);
    }
    const customerDetails = await this.getCustomerDetails(bookingInput, sessionUser);
    return this.createPaymentAndSync(
      idempotencyId,
      booking,
      booking.totalAmount,
      customerDetails,
      bookingInput.callbackUrl,
      sessionUser === null,
    );
  }

  private async releaseIdempotencyClaim(idempotencyId: string): Promise<void> {
    try {
      await this.idempotencyService.release(idempotencyId);
    } catch (error) {
      this.logger.error(
        {
          idempotencyId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to release pre-side-effect booking idempotency claim",
      );
    }
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

    // Airport pickup search enforces Lagos destination via typed error codes.
    const { flight } = await this.flightAwareService.searchAirportPickupFlight(
      flightNumber,
      pickupDateStr,
    );

    // Calculate drive time if we have the drop-off address
    let driveTimeMinutes: number | undefined;
    if (dropOffAddress) {
      const driveTimeResult = await this.mapsService.calculateAirportTripDuration(dropOffAddress);
      driveTimeMinutes = driveTimeResult.durationMinutes;
    }

    const arrivalTime = new Date(flight.arrivalTime);
    const departureTime = new Date(flight.scheduledDeparture);
    if (Number.isNaN(arrivalTime.getTime()) || Number.isNaN(departureTime.getTime())) {
      throw new FlightAwareApiException("FlightAware returned invalid flight timing data");
    }

    return {
      flightId: flight.flightId,
      arrivalTime,
      departureTime,
      flightNumber: flight.flightNumber,
      originCode: flight.origin,
      originCodeIATA: flight.originIATA,
      originTimezone: flight.originTimezone,
      originName: flight.originName,
      destinationCode: flight.destination,
      destinationIATA: flight.destinationIATA,
      destinationName: flight.destinationName,
      destinationCity: flight.destinationCity,
      driveTimeMinutes,
    };
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
    idempotencyId: string;
    booking: CreateBookingInput;
    sessionUser: AuthSession["user"] | null;
    context?: BookingCreationContext;
    legs: GeneratedLeg[];
    financials: BookingFinancials;
    customerDetails: CustomerDetails;
    flightData: FlightDataForBooking | null;
    preliminaryReferralEligibility: ReferralEligibility;
  }): Promise<CreateBookingResponse> {
    const {
      idempotencyId,
      booking,
      sessionUser,
      context,
      legs,
      financials,
      customerDetails,
      flightData,
      preliminaryReferralEligibility,
    } = params;

    const preferredNotificationChannel = this.resolvePreferredNotificationChannel(
      context,
      customerDetails.phoneNumber,
    );

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

    let createdBooking: Booking;
    let finalizedFinancials = financials;

    const bookingReference = generateBookingReference();

    try {
      createdBooking = await this.databaseService.$transaction(async (tx) => {
        const carExists = await lockCarRow(tx, booking.carId);
        if (!carExists) {
          throw new BookingCreationFailedException("Car not found during booking creation.");
        }
        await this.validationService.checkCarAvailability(
          {
            carId: booking.carId,
            startDate: booking.startDate,
            endDate: booking.endDate,
          },
          tx,
        );
        const freshCar = await this.persistenceService.fetchCarWithPricing(booking.carId, tx);

        // CRITICAL: Verify and reserve referral discount FIRST with pessimistic locking.
        // This prevents concurrent active bookings from receiving the one-time discount.
        const verifiedReferralEligibility = sessionUser
          ? await this.eligibilityService.verifyAndReserveReferralDiscountInTransaction(
              tx,
              sessionUser.id,
              preliminaryReferralEligibility,
            )
          : preliminaryReferralEligibility;

        const recalculatedFinancials = await this.calculateFinancials(
          booking,
          freshCar,
          legs,
          verifiedReferralEligibility.discountAmount,
          tx,
        );

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
        }

        this.validationService.validateExpectedPrice(
          booking.expectedTotalAmount,
          recalculatedFinancials,
        );
        finalizedFinancials = recalculatedFinancials;

        const flightRecordId = await this.persistenceService.createFlightRecordIfNeeded(
          tx,
          booking,
          flightData,
        );

        const bookingRecord = await this.persistenceService.createBookingRecord(tx, {
          bookingReference,
          car: freshCar,
          userId: sessionUser?.id ?? null,
          guestUser,
          booking,
          financials: finalizedFinancials,
          referralEligibility: verifiedReferralEligibility,
          flightRecordId,
          legs,
        });

        // Create pending referral reward record for the reserved discount.
        await this.eligibilityService.createReferralRewardIfEligible(
          tx,
          bookingRecord.id,
          verifiedReferralEligibility,
          sessionUser?.id ?? null,
        );
        await tx.booking.update({
          where: { id: bookingRecord.id },
          data: { paymentIntent: bookingRecord.id },
        });
        await this.idempotencyService.attachBooking(tx, idempotencyId, bookingRecord.id);

        return { ...bookingRecord, paymentIntent: bookingRecord.id };
      });
    } catch (error) {
      // Re-throw domain-specific exceptions (includes ReferralDiscountNoLongerAvailableException)
      if (error instanceof BookingException || error instanceof FlightAwareException) {
        throw error;
      }
      if (this.reservationService.isOverlapConstraintViolation(error)) {
        throw new CarNotAvailableException(booking.carId);
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

    return this.createPaymentAndSync(
      idempotencyId,
      createdBooking,
      finalizedFinancials.totalAmount,
      customerDetails,
      booking.callbackUrl,
      sessionUser === null,
    );
  }

  private resolvePreferredNotificationChannel(
    context: BookingCreationContext | undefined,
    phoneNumber: string | null | undefined,
  ): "WHATSAPP_ONLY" | "EMAIL_AND_WHATSAPP" | "EMAIL_ONLY" {
    if (context?.guestContactSource === "WHATSAPP_AGENT") {
      return "WHATSAPP_ONLY";
    }
    if (phoneNumber) {
      return "EMAIL_AND_WHATSAPP";
    }
    return "EMAIL_ONLY";
  }

  private async createPaymentAndSync(
    idempotencyId: string,
    createdBooking: Booking,
    totalAmount: Decimal,
    customerDetails: CustomerDetails,
    callbackUrl?: string,
    isGuest = false,
  ): Promise<CreateBookingResponse> {
    try {
      const paymentResult = await this.paymentService.createPaymentIntent(
        createdBooking,
        totalAmount,
        customerDetails,
        callbackUrl,
      );
      const reservationExpiresAt = new Date(Date.now() + BOOKING_PAYMENT_SESSION_DURATION_MS);
      const paymentStatusCredential = isGuest
        ? createBookingPaymentStatusToken(
            createdBooking.id,
            this.configService.get("SESSION_SECRET", { infer: true }),
          )
        : null;
      const response: CreateBookingResponse = {
        bookingId: createdBooking.id,
        checkoutUrl: paymentResult.checkoutUrl,
        totalAmount: totalAmount.toNumber(),
        currency: "NGN",
        bookingStatus: createdBooking.status,
        reservationExpiresAt: reservationExpiresAt.toISOString(),
        ...(paymentStatusCredential ? { paymentStatusToken: paymentStatusCredential.token } : {}),
      };
      await this.syncPaymentIntentWithBooking(
        idempotencyId,
        createdBooking.id,
        paymentResult.paymentIntentId,
        reservationExpiresAt,
        paymentStatusCredential?.tokenHash ?? null,
        response,
      );
      return response;
    } catch (error) {
      if (
        error instanceof BookingPaymentSyncFailedException ||
        error instanceof BookingCreationFailedException
      ) {
        throw error;
      }

      await this.handlePaymentFailureCompensation(createdBooking, error);

      if (error instanceof PaymentIntentFailedException) {
        throw error;
      }
      throw new PaymentIntentFailedException();
    }
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
    idempotencyId: string,
    bookingId: string,
    paymentIntentId: string,
    reservationExpiresAt: Date,
    paymentStatusTokenHash: string | null,
    response: CreateBookingResponse,
  ): Promise<void> {
    try {
      await this.idempotencyService.checkpointPaymentResult(
        idempotencyId,
        bookingId,
        paymentIntentId,
        reservationExpiresAt,
        paymentStatusTokenHash,
        response,
      );
      await this.idempotencyService.complete(idempotencyId);
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
}
