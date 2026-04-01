import { Injectable, Logger } from "@nestjs/common";
import { maskEmail } from "../../../shared/helper";
import { CarNotAvailableException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { DatabaseService } from "../../database/database.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import {
  type BookingDraft,
  convertToExtractedParams,
  type VehicleSearchOption,
} from "./langgraph.interface";
import { buildBookingInputFromDraft, buildGuestIdentity } from "./langgraph-booking-orchestrator";
import { normalizeNodeError } from "./langgraph-log-utils";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

@Injectable()
export class CreateBookingNode {
  private readonly logger = new Logger(CreateBookingNode.name);

  constructor(
    private readonly bookingCreationService: BookingCreationService,
    private readonly databaseService: DatabaseService,
    private readonly bookingAgentSearchService: BookingAgentSearchService,
  ) {}

  async run(state: LangGraphNodeState): Promise<LangGraphNodeResult> {
    const { draft, selectedOption } = state;

    if (!selectedOption) {
      this.logger.error("Create booking node called without selected option");
      return {
        error: "No vehicle selected for booking",
        stage: "confirming",
      };
    }

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

      this.logger.log("Creating booking", {
        conversationId: state.conversationId,
        vehicleId: selectedOption.id,
        draftFieldCount: Object.keys(draft).length,
        hasPickupLocation: !!draft.pickupLocation,
        hasDropoffLocation: !!draft.dropoffLocation,
        hasPickupDate: !!draft.pickupDate,
        hasDropoffDate: !!draft.dropoffDate,
      });

      const guestIdentity = buildGuestIdentity(conversation.phoneE164, conversation.profileName);
      const {
        input: bookingInput,
        normalizedStartDate,
        normalizedEndDate,
      } = buildBookingInputFromDraft(draft, selectedOption, guestIdentity);

      this.logBookingCreationInput(bookingInput, normalizedStartDate, normalizedEndDate);

      const result = await this.bookingCreationService.createBooking(bookingInput, null);

      this.logger.log("Booking created successfully", {
        bookingId: result.bookingId,
        checkoutUrl: result.checkoutUrl,
      });

      return {
        bookingId: result.bookingId,
        paymentLink: result.checkoutUrl,
        stage: "awaiting_payment",
      };
    } catch (error) {
      this.logBookingCreationFailure(state, selectedOption, error);

      if (error instanceof CarNotAvailableException) {
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

      return {
        error: LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE,
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
      this.logger.error("Conversation not found for booking creation", { conversationId });
    }

    return conversation;
  }

  private validateDraftBeforeBookingCreation(draft: BookingDraft): LangGraphNodeResult | null {
    if (!draft.pickupDate || !draft.dropoffDate || !draft.pickupTime) {
      const missingRequiredDraftFields: string[] = [];
      if (draft.pickupDate === undefined) {
        missingRequiredDraftFields.push("pickupDate");
      }
      if (draft.dropoffDate === undefined) {
        missingRequiredDraftFields.push("dropoffDate");
      }
      if (draft.pickupTime === undefined) {
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

  private async fetchFreshOptionsForDraft(
    draft: BookingDraft,
    excludedOptionId?: string,
  ): Promise<VehicleSearchOption[]> {
    try {
      const extractedParams = convertToExtractedParams(draft);
      const searchResult = await this.bookingAgentSearchService.searchVehiclesFromExtracted(
        extractedParams,
        "",
      );

      if (searchResult.precondition) {
        return [];
      }

      const options = [...searchResult.exactMatches, ...searchResult.alternatives]
        .filter((option) => option.id !== excludedOptionId)
        .slice(0, 5);

      this.logger.log("Fetched fresh options after booking unavailability", {
        excludedOptionId,
        optionCount: options.length,
      });

      return options;
    } catch (fallbackError) {
      this.logger.warn("Failed to fetch fresh options after booking unavailability", {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return [];
    }
  }

  private logBookingCreationInput(
    bookingInput: {
      carId: string;
      pickupAddress: string;
      bookingType: string;
      pickupTime?: string;
      clientTotalAmount?: string;
      sameLocation?: boolean;
      guestEmail?: string;
    },
    normalizedStartDate: Date,
    normalizedEndDate: Date,
  ): void {
    this.logger.log(
      {
        carId: bookingInput.carId,
        startDate: normalizedStartDate.toISOString(),
        endDate: normalizedEndDate.toISOString(),
        pickupAddress: bookingInput.pickupAddress,
        bookingType: bookingInput.bookingType,
        pickupTime: bookingInput.pickupTime,
        clientTotalAmount: bookingInput.clientTotalAmount,
        sameLocation: bookingInput.sameLocation,
        guestEmail: bookingInput.guestEmail ? maskEmail(bookingInput.guestEmail) : undefined,
      },
      "Calling BookingCreationService.createBooking",
    );
  }

  private logBookingCreationFailure(
    state: LangGraphNodeState,
    selectedOption: LangGraphNodeState["selectedOption"],
    error: unknown,
  ): void {
    const normalizedError = normalizeNodeError(error);

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
