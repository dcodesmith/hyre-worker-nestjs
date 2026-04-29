import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { maskEmail } from "../../../shared/helper";
import type { AuthSession } from "../../auth/guards/session.guard";
import { CarNotAvailableException, CarNotFoundException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import type { CreateBookingInput } from "../../booking/dto/create-booking.dto";
import { DatabaseService } from "../../database/database.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import {
  type BookingDraft,
  convertToExtractedParams,
  type VehicleSearchOption,
} from "./langgraph.interface";
import { buildBookingInputFromDraft, buildGuestIdentity } from "./langgraph-booking-orchestrator";
import { normalizeNodeError } from "./langgraph-log-utils";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

const MAX_FALLBACK_OPTIONS = 5;
@Injectable()
export class CreateBookingNode {
  constructor(
    private readonly bookingCreationService: BookingCreationService,
    private readonly databaseService: DatabaseService,
    private readonly bookingAgentSearchService: BookingAgentSearchService,
    private readonly whatsAppPersistenceService: WhatsAppPersistenceService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CreateBookingNode.name);
  }

  async run(state: LangGraphNodeState): Promise<LangGraphNodeResult> {
    const { draft, selectedOption } = state;

    if (!selectedOption) {
      this.logger.error(
        { conversationId: state.conversationId },
        "Create booking node called without selected option",
      );

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
      } = buildBookingInputFromDraft(draft, selectedOption, guestIdentity);

      this.logBookingCreationInput(bookingInput, normalizedStartDate, normalizedEndDate);

      const conversationLinkState = await this.whatsAppPersistenceService.getConversationLinkState(
        state.conversationId,
      );
      const linkedCustomerId = this.resolveLinkedCustomerId(
        state.customerId,
        conversationLinkState,
      );
      const result = linkedCustomerId
        ? await this.bookingCreationService.createBooking({
            input: this.buildAuthenticatedBookingInput(bookingInput),
            sessionUser: { id: linkedCustomerId } as AuthSession["user"],
          })
        : await this.bookingCreationService.createBooking({
            input: bookingInput,
            sessionUser: null,
            context: {
              guestContactSource: "WHATSAPP_AGENT",
            },
          });

      this.logger.info({ bookingId: result.bookingId }, "Booking created successfully");

      return {
        bookingId: result.bookingId,
        paymentLink: result.checkoutUrl,
        stage: "awaiting_payment",
      };
    } catch (error) {
      this.logBookingCreationFailure(state, selectedOption, error);

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

    return rest as CreateBookingInput;
  }

  private validateDraftBeforeBookingCreation(draft: BookingDraft): LangGraphNodeResult | null {
    if (!draft.pickupDate || !draft.dropoffDate || !draft.pickupTime) {
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
    this.logger.info(
      {
        carId: bookingInput.carId,
        startDate: normalizedStartDate.toISOString(),
        endDate: normalizedEndDate.toISOString(),
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
