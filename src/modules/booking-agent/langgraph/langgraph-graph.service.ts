import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Injectable, Logger } from "@nestjs/common";
import { CarNotAvailableException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { DatabaseService } from "../../database/database.service";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import { LANGGRAPH_NODE_NAMES, LANGGRAPH_OUTBOUND_MODE } from "./langgraph.const";
import { LangGraphExecutionFailedException } from "./langgraph.error";
import type {
  AgentResponse,
  BookingAgentState,
  BookingDraft,
  BookingStage,
  ConversationMessage,
  ExtractionResult,
  InteractiveReply,
  LangGraphInvokeInput,
  LangGraphInvokeResult,
  LangGraphOutboxItem,
  UserPreferences,
  VehicleSearchOption,
} from "./langgraph.interface";
import { convertToExtractedParams } from "./langgraph.interface";
import { buildBookingInputFromDraft, buildGuestIdentity } from "./langgraph-booking-orchestrator";
import {
  applyDerivedDraftFields,
  getMissingRequiredFields,
  hasDraftChanged,
  shouldApplyDraftPatch,
} from "./langgraph-booking-rules";
import { LangGraphExtractorService } from "./langgraph-extractor.service";
import { buildOutboxItems } from "./langgraph-outbox.builder";
import { LangGraphResponderService } from "./langgraph-responder.service";
import { resolveRouteDecision } from "./langgraph-router.policy";
import { LangGraphStateService } from "./langgraph-state.service";

/**
 * Helper to create an Annotation channel with a default value.
 * Required when you want a default but no special reducer logic.
 */
function AnnotationWithDefault<T>(defaultValue: T) {
  return Annotation<T>({
    reducer: (_current: T, update: T) => update,
    default: () => defaultValue,
  });
}

const BookingAgentAnnotation = Annotation.Root({
  messages: Annotation<ConversationMessage[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  conversationId: Annotation<string>,
  customerId: AnnotationWithDefault<string | null>(null),
  inboundMessage: AnnotationWithDefault<string>(""),
  inboundMessageId: AnnotationWithDefault<string>(""),
  inboundInteractive: AnnotationWithDefault<InteractiveReply | undefined>(undefined),
  draft: Annotation<BookingDraft & { __clear?: boolean }>({
    reducer: (current, update) => {
      // Special flag to clear the draft completely
      if ("__clear" in update && update.__clear === true) {
        const { __clear: _, ...rest } = update;
        return rest;
      }
      return { ...current, ...update };
    },
    default: () => ({}),
  }),
  stage: Annotation<BookingStage>({
    reducer: (_, update) => update,
    default: () => "greeting",
  }),
  turnCount: Annotation<number>({
    reducer: (current, _) => current + 1,
    default: () => 0,
  }),
  extraction: AnnotationWithDefault<ExtractionResult | null>(null),
  availableOptions: Annotation<VehicleSearchOption[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  lastShownOptions: Annotation<VehicleSearchOption[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  selectedOption: AnnotationWithDefault<VehicleSearchOption | null>(null),
  holdId: AnnotationWithDefault<string | null>(null),
  holdExpiresAt: AnnotationWithDefault<string | null>(null),
  bookingId: AnnotationWithDefault<string | null>(null),
  paymentLink: AnnotationWithDefault<string | null>(null),
  preferences: Annotation<UserPreferences & { __clear?: boolean }>({
    reducer: (current, update) => {
      // Special flag to clear preferences completely
      if ("__clear" in update && update.__clear === true) {
        const { __clear: _, ...rest } = update;
        return rest;
      }
      return { ...current, ...update };
    },
    default: () => ({}),
  }),
  response: AnnotationWithDefault<AgentResponse | null>(null),
  outboxItems: Annotation<LangGraphOutboxItem[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  nextNode: AnnotationWithDefault<string | null>(null),
  error: AnnotationWithDefault<string | null>(null),
});

type AnnotationState = typeof BookingAgentAnnotation.State;

@Injectable()
export class LangGraphGraphService {
  private readonly logger = new Logger(LangGraphGraphService.name);
  private graph: ReturnType<typeof this.buildGraph> | null = null;

  constructor(
    private readonly stateService: LangGraphStateService,
    private readonly extractorService: LangGraphExtractorService,
    private readonly responderService: LangGraphResponderService,
    private readonly bookingAgentSearchService: BookingAgentSearchService,
    private readonly bookingCreationService: BookingCreationService,
    private readonly databaseService: DatabaseService,
  ) {}

  async invoke(input: LangGraphInvokeInput): Promise<LangGraphInvokeResult> {
    const { conversationId, messageId, message, interactive, customerId } = input;

    try {
      const existingState = await this.stateService.loadState(conversationId);

      let initialState: BookingAgentState;
      if (existingState) {
        initialState = this.stateService.mergeWithExisting(
          existingState,
          conversationId,
          messageId,
          message,
          customerId ?? null,
        );
      } else {
        initialState = this.stateService.createInitialState(
          conversationId,
          messageId,
          message,
          customerId ?? null,
        );
      }

      if (interactive) {
        initialState.inboundInteractive = interactive;
      }

      this.stateService.addMessage(initialState, "user", message);

      const graph = this.getOrBuildGraph();
      const result = await graph.invoke(initialState, {
        configurable: { thread_id: conversationId },
      });

      const finalState = result as BookingAgentState;

      if (finalState.response) {
        this.stateService.addMessage(finalState, "assistant", finalState.response.text);
      }

      await this.stateService.saveState(conversationId, finalState);

      return {
        response: finalState.response,
        outboxItems: finalState.outboxItems,
        stage: finalState.stage,
        draft: finalState.draft,
        error: finalState.error,
      };
    } catch (error) {
      this.logger.error("Graph execution failed", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LangGraphExecutionFailedException(
        conversationId,
        "invoke",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private getOrBuildGraph() {
    if (!this.graph) {
      this.graph = this.buildGraph();
    }
    return this.graph;
  }

  private buildGraph() {
    const workflow = new StateGraph(BookingAgentAnnotation)
      .addNode(LANGGRAPH_NODE_NAMES.EXTRACT, this.extractNode.bind(this))
      .addNode(LANGGRAPH_NODE_NAMES.MERGE, this.mergeNode.bind(this))
      .addNode(LANGGRAPH_NODE_NAMES.ROUTE, this.routeNode.bind(this))
      .addNode(LANGGRAPH_NODE_NAMES.SEARCH, this.searchNode.bind(this))
      .addNode(LANGGRAPH_NODE_NAMES.CREATE_BOOKING, this.createBookingNode.bind(this))
      .addNode(LANGGRAPH_NODE_NAMES.RESPOND, this.respondNode.bind(this))
      .addNode(LANGGRAPH_NODE_NAMES.HANDOFF, this.handoffNode.bind(this))
      .addEdge(START, LANGGRAPH_NODE_NAMES.EXTRACT)
      .addEdge(LANGGRAPH_NODE_NAMES.EXTRACT, LANGGRAPH_NODE_NAMES.MERGE)
      .addEdge(LANGGRAPH_NODE_NAMES.MERGE, LANGGRAPH_NODE_NAMES.ROUTE)
      .addConditionalEdges(LANGGRAPH_NODE_NAMES.ROUTE, this.routeDecision.bind(this))
      .addEdge(LANGGRAPH_NODE_NAMES.SEARCH, LANGGRAPH_NODE_NAMES.RESPOND)
      .addEdge(LANGGRAPH_NODE_NAMES.CREATE_BOOKING, LANGGRAPH_NODE_NAMES.RESPOND)
      .addEdge(LANGGRAPH_NODE_NAMES.RESPOND, END)
      .addEdge(LANGGRAPH_NODE_NAMES.HANDOFF, END);

    const checkpointer = new MemorySaver();
    return workflow.compile({ checkpointer });
  }

  private async extractNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
    try {
      const extraction = await this.extractorService.extract(state);
      this.logger.log("Extract node completed", {
        intent: extraction.intent,
        draftPatch: extraction.draftPatch,
        confidence: extraction.confidence,
      });
      return { extraction };
    } catch (error) {
      this.logger.error("Extract node failed", { error });
      return {
        extraction: {
          intent: "unknown",
          draftPatch: {},
          confidence: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private mergeNode(state: AnnotationState): Partial<AnnotationState> {
    const { extraction, draft, preferences } = state;

    if (!extraction) {
      return {};
    }

    const baseDraft = shouldApplyDraftPatch(extraction.intent)
      ? { ...draft, ...extraction.draftPatch }
      : { ...draft };
    const newDraft = applyDerivedDraftFields(baseDraft, state.inboundMessage);

    const newPreferences = { ...preferences };
    if (extraction.preferenceHint) {
      if (extraction.preferenceHint === "cheaper" || extraction.preferenceHint === "budget") {
        newPreferences.pricePreference = "budget";
      } else if (
        extraction.preferenceHint === "premium" ||
        extraction.preferenceHint === "luxury"
      ) {
        newPreferences.pricePreference = "premium";
      }
      if (!newPreferences.notes) {
        newPreferences.notes = [];
      }
      newPreferences.notes.push(extraction.preferenceHint);
    }

    const draftChanged = hasDraftChanged(draft, newDraft);
    const shouldClearOptions = draftChanged && state.availableOptions.length > 0;

    this.logger.debug("Merge node completed", {
      newDraft,
      autoFilledDropoffLocation: !draft.dropoffLocation && !!newDraft.dropoffLocation,
      autoFilledDropoffDate: !draft.dropoffDate && !!newDraft.dropoffDate,
    });

    return {
      draft: newDraft,
      preferences: newPreferences,
      availableOptions: shouldClearOptions ? [] : state.availableOptions,
      lastShownOptions: shouldClearOptions ? [] : state.lastShownOptions,
    };
  }

  private routeNode(state: AnnotationState): Partial<AnnotationState> {
    const { extraction, draft, stage, availableOptions, selectedOption } = state;

    const missingFields = getMissingRequiredFields(draft);
    this.logger.log("Route node decision", {
      intent: extraction?.intent,
      stage,
      missingFields,
      hasSelectedOption: !!selectedOption,
      availableOptionsCount: availableOptions.length,
      draft: {
        bookingType: draft.bookingType,
        pickupDate: draft.pickupDate,
        pickupTime: draft.pickupTime,
        dropoffDate: draft.dropoffDate,
        pickupLocation: draft.pickupLocation,
        dropoffLocation: draft.dropoffLocation,
      },
    });

    const decision = resolveRouteDecision(state as BookingAgentState);
    return decision;
  }

  private routeDecision(state: AnnotationState): string {
    return state.nextNode ?? LANGGRAPH_NODE_NAMES.RESPOND;
  }

  private async searchNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
    try {
      const extractedParams = convertToExtractedParams(state.draft);
      this.logger.log(
        {
          draft: state.draft,
          extractedParams,
        },
        "Search node executing",
      );
      const searchResult = await this.bookingAgentSearchService.searchVehiclesFromExtracted(
        extractedParams,
        "",
      );

      // Check if there's a precondition issue (missing/invalid field)
      if (searchResult.precondition) {
        this.logger.warn("Search returned precondition", {
          precondition: searchResult.precondition,
          extractedParams,
        });
        // Go back to collecting stage to ask for the missing field
        return {
          availableOptions: [],
          stage: "collecting",
          error: searchResult.precondition.prompt,
        };
      }

      const options: VehicleSearchOption[] = [
        ...searchResult.exactMatches,
        ...searchResult.alternatives,
      ].slice(0, 5);

      const newStage: BookingStage = options.length > 0 ? "presenting_options" : "collecting";

      this.logger.log("Search node completed", {
        exactMatchCount: searchResult.exactMatches.length,
        alternativeCount: searchResult.alternatives.length,
        totalOptions: options.length,
        newStage,
        optionDetails: options.map((o) => ({
          id: o.id,
          make: o.make,
          model: o.model,
          price: o.estimatedTotalInclVat,
        })),
      });

      // If no vehicles found, set an error message so the responder can inform the user
      const noResultsError =
        options.length === 0
          ? "No vehicles matching your criteria are available for the selected date. Would you like to try a different date, vehicle type, or booking type?"
          : null;

      return {
        availableOptions: options,
        lastShownOptions: options,
        stage: newStage,
        error: noResultsError,
      };
    } catch (error) {
      this.logger.error("Search node failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        error: error instanceof Error ? error.message : String(error),
        availableOptions: [],
      };
    }
  }

  private async respondNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
    try {
      this.logger.log(
        {
          stage: state.stage,
          availableOptionsCount: state.availableOptions.length,
          lastShownOptionsCount: state.lastShownOptions.length,
          hasSelectedOption: !!state.selectedOption,
        },
        "Respond node executing",
      );
      this.logger.debug("Respond node draft details", { draft: state.draft });

      const response = await this.responderService.generateResponse(state);

      const outboxItems = buildOutboxItems(state, response);

      return { response, outboxItems };
    } catch (error) {
      this.logger.error("Respond node failed", { error });
      return {
        response: {
          text: "I'm having trouble right now. Please try again or type AGENT to speak with someone.",
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async createBookingNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
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
        phone: conversation.phoneE164,
        vehicleId: selectedOption.id,
        draft,
      });

      const guestIdentity = buildGuestIdentity(conversation.phoneE164, conversation.profileName);
      const {
        input: bookingInput,
        normalizedStartDate,
        normalizedEndDate,
      } = buildBookingInputFromDraft(draft, selectedOption, guestIdentity);

      this.logBookingCreationInput(bookingInput, normalizedStartDate, normalizedEndDate);

      // For WhatsApp bookings, we create as a guest booking
      const result = await this.bookingCreationService.createBooking(
        bookingInput as Parameters<typeof this.bookingCreationService.createBooking>[0],
        null, // No session user for WhatsApp bookings
      );

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
            error:
              "That vehicle is no longer available for your selected date and time. Here are updated available options.",
          };
        }

        return {
          selectedOption: null,
          availableOptions: [],
          lastShownOptions: [],
          stage: "collecting",
          error:
            "That vehicle is no longer available for your selected date and time. Please adjust your date, booking type, or vehicle preference.",
        };
      }

      // Keep a user-safe fallback message for unexpected booking failures.
      return {
        error:
          "I couldn't create your booking just now. Please try again or type AGENT to speak with someone.",
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

  private validateDraftBeforeBookingCreation(draft: BookingDraft): Partial<AnnotationState> | null {
    if (!draft.pickupTime) {
      this.logger.error({ draft }, "Missing pickupTime in draft - cannot create booking");
      return {
        error: "Missing pickup time - please specify when you need the vehicle",
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
      pickupTime: string;
      clientTotalAmount?: string;
      sameLocation: boolean;
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
        guestEmail: bookingInput.guestEmail,
      },
      "Calling BookingCreationService.createBooking",
    );
  }

  private logBookingCreationFailure(
    state: AnnotationState,
    selectedOption: BookingAgentState["selectedOption"],
    error: unknown,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";

    this.logger.error(
      {
        errorName,
        errorMessage,
        conversationId: state.conversationId,
        draft: state.draft,
        selectedOptionId: selectedOption?.id,
        selectedOptionPrice: selectedOption?.estimatedTotalInclVat,
        stack: error instanceof Error ? error.stack : undefined,
      },
      "Booking creation failed",
    );
  }

  private handoffNode(state: AnnotationState): Partial<AnnotationState> {
    return {
      response: {
        text: "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
      },
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:handoff:${state.inboundMessageId}`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody:
            "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
        },
      ],
      stage: "cancelled",
    };
  }
}
