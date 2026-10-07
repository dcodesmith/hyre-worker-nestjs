import { Injectable } from "@nestjs/common";
import { formatInTimeZone } from "date-fns-tz";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { maskEmail } from "../../../shared/helper";
import type { AuthSession } from "../../auth/guards/session.guard";
import { PRICE_TOLERANCE } from "../../booking/booking.const";
import {
  BookingFlightWindowChangedException,
  BookingPhoneVerificationRequiredException,
  BookingPriceChangedException,
  BookingRequestInProgressException,
  BookingValidationException,
  CarNotAvailableException,
  CarNotFoundException,
  IdempotencyKeyReusedException,
} from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { BookingPricingPreviewService } from "../../booking/booking-pricing-preview.service";
import type { CreateBookingInput } from "../../booking/dto/create-booking.dto";
import type { BookingPricingPreviewResponseDto } from "../../booking/dto/pricing-preview.dto";
import { DatabaseService } from "../../database/database.service";
import { FlightAwareException } from "../../flightaware/flightaware.error";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { buildBookingInputFromDraft, buildGuestIdentity } from "./booking-orchestrator";
import { clearDerivedAirportFields } from "./booking-rules";
import { getBookingAgentServiceUnavailableMessage } from "./conversation.const";
import {
  type BookingAgentState,
  type BookingDraft,
  convertToExtractedParams,
  type VehicleSearchOption,
} from "./conversation.interface";
import { normalizeActionError } from "./conversation-log-utils";

const MAX_FALLBACK_OPTIONS = 5;
@Injectable()
export class CreateBookingAction {
  constructor(
    private readonly bookingCreationService: BookingCreationService,
    private readonly bookingPricingPreviewService: BookingPricingPreviewService,
    private readonly databaseService: DatabaseService,
    private readonly bookingAgentSearchService: BookingAgentSearchService,
    private readonly whatsAppPersistenceService: WhatsAppPersistenceService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CreateBookingAction.name);
  }

  async run(state: BookingAgentState): Promise<Partial<BookingAgentState>> {
    const { draft, selectedOption } = state;

    if (!selectedOption) {
      this.logger.error(
        { conversationId: state.conversationId },
        "Create booking action called without selected option",
      );

      return {
        error: "No vehicle selected for booking",
        stage: "confirming",
      };
    }
    if (!state.pricingPreview) {
      return {
        error: "The final quote is not ready yet. Please try again.",
        stage: "confirming",
      };
    }
    const confirmedPricing = state.pricingPreview;

    try {
      const conversation = await this.getConversationForBooking(state.conversationId);
      if (!conversation) {
        return {
          error: "Unable to create booking - conversation not found",
          stage: "confirming",
        };
      }

      const validationError = this.validateDraftBeforeBookingCreation(draft);
      if (validationError) {
        return validationError;
      }

      this.logger.info(
        {
          conversationId: state.conversationId,
          vehicleId: selectedOption.id,
          draftFieldCount: Object.keys(draft).length,
          hasPickupLocation: !!draft.pickupLocation,
          hasDropoffLocation: !!draft.dropoffLocation,
          hasPickupDate: !!draft.pickupDate,
          hasDropoffDate: !!draft.dropoffDate,
        },
        "Creating booking",
      );

      const guestIdentity = buildGuestIdentity(conversation.phoneE164, conversation.profileName);
      const {
        input: bookingInput,
        normalizedStartDate,
        normalizedEndDate,
      } = buildBookingInputFromDraft(draft, selectedOption, guestIdentity, {
        addonIds: state.selectedAddonIds ?? [],
        requiresFullTank: state.requiresFullTank ?? false,
        useCredits: state.useCredits ?? 0,
        expectedTotalAmount: new Decimal(confirmedPricing.totalAmount).toString(),
      });

      const conversationLinkState = await this.whatsAppPersistenceService.getConversationLinkState(
        state.conversationId,
      );
      const linkedCustomerId = this.resolveLinkedCustomerId(
        state.customerId,
        conversationLinkState,
      );
      const sessionUser = linkedCustomerId
        ? ({ id: linkedCustomerId } as AuthSession["user"])
        : null;
      const pricing = await this.bookingPricingPreviewService.preview(
        {
          carId: bookingInput.carId,
          bookingType: bookingInput.bookingType,
          startDate: bookingInput.startDate,
          endDate: bookingInput.endDate,
          pickupTime: bookingInput.pickupTime,
          addonIds: bookingInput.addonIds,
          requiresFullTank: bookingInput.requiresFullTank,
          useCredits: bookingInput.useCredits,
        },
        sessionUser,
      );
      if (
        new Decimal(pricing.totalAmount).sub(confirmedPricing.totalAmount).abs().gt(PRICE_TOLERANCE)
      ) {
        return {
          pricingPreview: pricing,
          stage: "confirming",
          statusMessage:
            "Pricing changed while you were confirming. Please review the updated quote.",
        };
      }
      const authoritativeBookingInput = {
        ...bookingInput,
        expectedTotalAmount: new Decimal(pricing.totalAmount).toString(),
      };

      this.logBookingCreationInput(
        authoritativeBookingInput,
        normalizedStartDate,
        normalizedEndDate,
      );

      const result = linkedCustomerId
        ? await this.bookingCreationService.createBooking({
            input: this.buildAuthenticatedBookingInput(authoritativeBookingInput),
            sessionUser,
            idempotencyKey: `whatsapp:${state.inboundMessageId}`,
            context: {
              requireFlightWindowConfirmation: true,
            },
          })
        : await this.bookingCreationService.createBooking({
            input: authoritativeBookingInput,
            sessionUser: null,
            idempotencyKey: `whatsapp:${state.inboundMessageId}`,
            context: {
              guestContactSource: "WHATSAPP_AGENT",
              requireFlightWindowConfirmation: true,
            },
          });

      this.logger.info({ bookingId: result.bookingId }, "Booking created successfully");

      return {
        bookingId: result.bookingId,
        holdId: result.bookingId,
        holdExpiresAt: result.reservationExpiresAt,
        paymentLink: result.checkoutUrl,
        stage: "awaiting_payment",
      };
    } catch (error) {
      this.logBookingCreationFailure(state, selectedOption, error);

      if (error instanceof BookingPriceChangedException) {
        const currentPricing = error.getDetails()?.currentPricing as
          | BookingPricingPreviewResponseDto
          | undefined;
        if (currentPricing) {
          return {
            pricingPreview: currentPricing,
            error: null,
            stage: "confirming",
            statusMessage:
              "Pricing changed while you were confirming. Please review the updated quote.",
          };
        }
      }

      if (error instanceof BookingFlightWindowChangedException) {
        return this.mapFlightWindowChange(state.draft, error);
      }

      if (error instanceof BookingPhoneVerificationRequiredException) {
        return {
          error:
            "Verify your phone number in your Tripdly account settings, then return here and try again.",
          statusMessage: null,
          stage: "confirming",
        };
      }

      const flightCollectionResult = this.mapFlightCollectionError(state.draft, error);
      if (flightCollectionResult) return flightCollectionResult;

      if (error instanceof CarNotAvailableException || error instanceof CarNotFoundException) {
        const fallbackOptions = await this.fetchFreshOptionsForDraft(
          state.draft,
          selectedOption.id,
        );
        if (fallbackOptions.length > 0) {
          return {
            selectedOption: null,
            availableOptions: fallbackOptions,
            lastShownOptions: fallbackOptions,
            stage: "presenting_options",
            statusMessage:
              "That vehicle is no longer available for your selected date and time. Here are some alternatives.",
          };
        }

        return {
          selectedOption: null,
          availableOptions: [],
          lastShownOptions: [],
          stage: "collecting",
          error: null,
          statusMessage:
            "That vehicle is no longer available for your selected date and time. Please adjust your date, booking type, or vehicle preference.",
        };
      }

      const idempotencyResult = this.mapIdempotencyError(error);
      if (idempotencyResult) return idempotencyResult;

      return {
        error: getBookingAgentServiceUnavailableMessage(),
        statusMessage: null,
        stage: "confirming",
      };
    }
  }

  private async getConversationForBooking(conversationId: string) {
    const conversation = await this.databaseService.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: {
        phoneE164: true,
        profileName: true,
      },
    });

    if (!conversation) {
      this.logger.error({ conversationId }, "Conversation not found for booking creation");
    }

    return conversation;
  }

  private resolveLinkedCustomerId(
    stateCustomerId: string | null,
    conversation: {
      linkedUserId: string | null;
      linkStatus: string | null;
    },
  ): string | null {
    if (conversation.linkStatus !== "LINKED" || !conversation.linkedUserId) {
      return null;
    }

    if (stateCustomerId && stateCustomerId !== conversation.linkedUserId) {
      this.logger.warn(
        { stateCustomerId, linkedUserId: conversation.linkedUserId },
        "State customerId does not match linked conversation userId",
      );
    }

    return conversation.linkedUserId;
  }

  private buildAuthenticatedBookingInput(input: CreateBookingInput): CreateBookingInput {
    const {
      guestEmail: _guestEmail,
      guestName: _guestName,
      guestPhone: _guestPhone,
      ...rest
    } = input as CreateBookingInput & {
      guestEmail?: string;
      guestName?: string;
      guestPhone?: string;
    };

    return rest;
  }

  private validateDraftBeforeBookingCreation(
    draft: BookingDraft,
  ): Partial<BookingAgentState> | null {
    if (!draft.pickupDate || !draft.dropoffDate || !draft.pickupTime) {
      if (draft.bookingType === "AIRPORT_PICKUP") {
        return this.returnToFlightCollection(
          draft,
          "I need to validate your flight again. Please confirm the flight number and flight date.",
        );
      }

      const missingRequiredDraftFields: string[] = [];
      if (!draft.pickupDate) {
        missingRequiredDraftFields.push("pickupDate");
      }

      if (!draft.dropoffDate) {
        missingRequiredDraftFields.push("dropoffDate");
      }

      if (!draft.pickupTime) {
        missingRequiredDraftFields.push("pickupTime");
      }

      this.logger.error(
        { missingRequiredDraftFields },
        "Missing required date/time fields in draft - cannot create booking",
      );

      return {
        error:
          "Missing required booking details. Please provide pickup date, drop-off date, and pickup time.",
        stage: "collecting",
      };
    }

    return null;
  }

  private returnToFlightCollection(
    draft: BookingDraft,
    statusMessage: string,
  ): Partial<BookingAgentState> {
    return {
      draft: clearDerivedAirportFields(draft),
      selectedOption: null,
      availableOptions: [],
      lastShownOptions: [],
      availableAddons: [],
      selectedAddonIds: [],
      addonSelectionIndex: 0,
      requiresFullTank: false,
      useCredits: 0,
      pricingPreview: null,
      error: null,
      statusMessage,
      stage: "collecting",
    };
  }

  private mapFlightCollectionError(
    draft: BookingDraft,
    error: unknown,
  ): Partial<BookingAgentState> | null {
    if (error instanceof FlightAwareException) {
      return this.returnToFlightCollection(draft, error.message);
    }
    if (error instanceof BookingValidationException && draft.bookingType === "AIRPORT_PICKUP") {
      const message =
        error
          .getProblemDetails()
          .errors?.map((fieldError) => fieldError.message)
          .join(" ") || error.message;
      return this.returnToFlightCollection(draft, message);
    }
    return null;
  }

  private mapFlightWindowChange(
    draft: BookingDraft,
    error: BookingFlightWindowChangedException,
  ): Partial<BookingAgentState> {
    const pickupDateTime = error.currentStartDate.toISOString();
    const dropoffDateTime = error.currentEndDate.toISOString();
    const updatedDraft: BookingDraft = {
      ...draft,
      pickupDateTime,
      pickupTime: formatInTimeZone(error.currentStartDate, "Africa/Lagos", "HH:mm"),
      dropoffDate: formatInTimeZone(error.currentEndDate, "Africa/Lagos", "yyyy-MM-dd"),
      dropoffDateTime,
    };

    const pickupDisplay = formatInTimeZone(
      error.currentStartDate,
      "Africa/Lagos",
      "MMM d, yyyy 'at' h:mm a",
    );
    const dropoffDisplay = formatInTimeZone(
      error.currentEndDate,
      "Africa/Lagos",
      "MMM d, yyyy 'at' h:mm a",
    );

    return {
      draft: updatedDraft,
      error: null,
      stage: "confirming",
      statusMessage: `Your flight timing changed. Pickup is now ${pickupDisplay}, with estimated drop-off at ${dropoffDisplay}. Please confirm the updated booking times.`,
    };
  }

  private async fetchFreshOptionsForDraft(
    draft: BookingDraft,
    excludedOptionId?: string,
  ): Promise<VehicleSearchOption[]> {
    try {
      const extractedParams = convertToExtractedParams(draft);
      const searchResult = await this.bookingAgentSearchService.searchVehiclesFromExtracted(
        extractedParams,
        "",
        excludedOptionId,
      );

      if (searchResult.precondition) {
        return [];
      }

      const options = [...searchResult.exactMatches, ...searchResult.alternatives].slice(
        0,
        MAX_FALLBACK_OPTIONS,
      );

      this.logger.info(
        {
          excludedOptionId,
          optionCount: options.length,
        },
        "Fetched fresh options after booking unavailability",
      );

      return options;
    } catch (fallbackError) {
      this.logger.warn(
        {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        },
        "Failed to fetch fresh options after booking unavailability",
      );
      return [];
    }
  }

  private mapIdempotencyError(error: unknown): Partial<BookingAgentState> | null {
    if (error instanceof BookingRequestInProgressException) {
      return {
        error: null,
        statusMessage:
          "Your booking request is still being processed. Please wait a few seconds, then confirm again.",
        stage: "confirming",
      };
    }

    if (error instanceof IdempotencyKeyReusedException) {
      return {
        error: null,
        statusMessage:
          "Your booking details changed while the previous request was processing. Please review them and confirm again.",
        stage: "confirming",
      };
    }

    return null;
  }

  private logBookingCreationInput(
    bookingInput: {
      carId: string;
      pickupAddress: string;
      bookingType: string;
      pickupTime?: string;
      expectedTotalAmount: string;
      sameLocation?: boolean;
      guestEmail?: string;
    },
    normalizedStartDate: Date,
    normalizedEndDate: Date,
  ): void {
    this.logger.info(
      {
        carId: bookingInput.carId,
        startDate: normalizedStartDate.toISOString(),
        endDate: normalizedEndDate.toISOString(),
        bookingType: bookingInput.bookingType,
        pickupTime: bookingInput.pickupTime,
        expectedTotalAmount: bookingInput.expectedTotalAmount,
        sameLocation: bookingInput.sameLocation,
        guestEmail: bookingInput.guestEmail ? maskEmail(bookingInput.guestEmail) : undefined,
      },
      "Calling BookingCreationService.createBooking",
    );
  }

  private logBookingCreationFailure(
    state: BookingAgentState,
    selectedOption: BookingAgentState["selectedOption"],
    error: unknown,
  ): void {
    const normalizedError = normalizeActionError(error);

    this.logger.error(
      {
        errorName: normalizedError.errorName,
        errorMessage: normalizedError.errorMessage,
        errorCode: normalizedError.errorCode,
        conversationId: state.conversationId,
        draftFieldCount: Object.keys(state.draft).length,
        hasPickupLocation: !!state.draft.pickupLocation,
        hasDropoffLocation: !!state.draft.dropoffLocation,
        selectedOptionId: selectedOption?.id,
        selectedOptionPrice: selectedOption?.estimatedTotalInclVat,
        stackSnippet: normalizedError.stackSnippet,
      },
      "Booking creation failed",
    );
  }
}
