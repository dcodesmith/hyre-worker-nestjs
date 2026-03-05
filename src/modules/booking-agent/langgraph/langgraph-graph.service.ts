import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Injectable, Logger } from "@nestjs/common";
import { CarNotAvailableException } from "../../booking/booking.error";
import { BookingCreationService } from "../../booking/booking-creation.service";
import { DatabaseService } from "../../database/database.service";
import { GooglePlacesService } from "../../maps/google-places.service";
import type { AddressLookupResult } from "../../maps/maps.interface";
import { getMissingRequiredFields } from "../booking-agent.helper";
import { BookingAgentSearchService } from "../booking-agent-search.service";
import {
  LANGGRAPH_NODE_NAMES,
  LANGGRAPH_OUTBOUND_MODE,
  LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE,
} from "./langgraph.const";
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
    reducer: (current, update) => (typeof update === "number" ? update : current + 1),
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
  locationSuggestions: Annotation({
    reducer: (_, update: BookingAgentState["locationSuggestions"]) => update,
    default: () => [],
  }),
  locationLookupTriggered: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),
  locationLookupFailed: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),
  nextNode: AnnotationWithDefault<string | null>(null),
  error: AnnotationWithDefault<string | null>(null),
  statusMessage: AnnotationWithDefault<string | null>(null),
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
    private readonly googlePlacesService: GooglePlacesService,
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

    return workflow.compile();
  }

  private async extractNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
    try {
      const extraction = await this.extractorService.extract(state);
      this.logger.log("Extract node completed", {
        intent: extraction.intent,
        draftPatch: extraction.draftPatch,
        confidence: extraction.confidence,
      });
      // Clear any prior system outage state once extraction succeeds.
      return { extraction, error: null };
    } catch (error) {
      this.logger.error("Extract node failed", { error });
      // When extraction fails (external service error), clear state and show user-friendly message.
      // Don't expose raw errors like "429 quota exceeded" to users.
      return {
        extraction: {
          intent: "unknown",
          draftPatch: {},
          confidence: 0,
        },
        error: LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE,
        statusMessage: null,
        draft: { __clear: true },
        preferences: { __clear: true },
        availableOptions: [],
        lastShownOptions: [],
        selectedOption: null,
        locationSuggestions: [],
        locationLookupTriggered: false,
        locationLookupFailed: false,
        stage: "greeting",
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

    const newPreferences = this.mergePreferencesWithHint(preferences, extraction.preferenceHint);

    const draftChanged = hasDraftChanged(draft, newDraft);
    const pickupLocationChanged = draft.pickupLocation !== newDraft.pickupLocation;
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
      locationSuggestions: pickupLocationChanged ? [] : (state.locationSuggestions ?? []),
      locationLookupTriggered: pickupLocationChanged ? false : !!state.locationLookupTriggered,
      locationLookupFailed: pickupLocationChanged ? false : !!state.locationLookupFailed,
    };
  }

  private mergePreferencesWithHint(
    preferences: BookingAgentState["preferences"],
    preferenceHint: string | undefined,
  ): BookingAgentState["preferences"] {
    const newPreferences = { ...preferences };
    if (!preferenceHint) {
      return newPreferences;
    }

    if (preferenceHint === "cheaper" || preferenceHint === "budget") {
      newPreferences.pricePreference = "budget";
    } else if (preferenceHint === "premium" || preferenceHint === "luxury") {
      newPreferences.pricePreference = "premium";
    }

    const existingNotes = newPreferences.notes ?? [];
    newPreferences.notes = [...existingNotes, preferenceHint];
    return newPreferences;
  }

  private routeNode(state: AnnotationState): Partial<AnnotationState> {
    const { extraction, draft, stage, availableOptions, selectedOption } = state;

    if (state.error === LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE) {
      return {
        nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
        stage: "greeting",
      };
    }

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
    const isControlIntent =
      extraction?.intent === "new_booking" ||
      extraction?.intent === "reset" ||
      extraction?.intent === "greeting" ||
      extraction?.intent === "cancel" ||
      extraction?.intent === "request_agent";
    const shouldRunEarlyPickupValidation =
      !isControlIntent &&
      (decision.nextNode ?? LANGGRAPH_NODE_NAMES.RESPOND) === LANGGRAPH_NODE_NAMES.RESPOND &&
      (decision.stage ?? stage) === "collecting" &&
      !!draft.pickupLocation &&
      (!state.locationLookupTriggered || (state.locationSuggestions ?? []).length > 0);
    if (shouldRunEarlyPickupValidation) {
      return {
        ...decision,
        nextNode: LANGGRAPH_NODE_NAMES.SEARCH,
        stage: "collecting",
      };
    }

    return decision;
  }

  private routeDecision(state: AnnotationState): string {
    return state.nextNode ?? LANGGRAPH_NODE_NAMES.RESPOND;
  }

  private async searchNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
    try {
      const validationResult = await this.validateAndNormalizeLocations(state);
      if (validationResult.earlyReturn) {
        return validationResult.earlyReturn;
      }
      const validatedDraft = validationResult.draft;

      // If location lookup previously failed (NO_MATCH) and user hasn't provided a new address,
      // don't proceed to search - stay in collecting stage to get a valid address.
      // Note: We use the explicit `locationLookupFailed` flag rather than inferring from
      // empty suggestions, because a successful search also clears suggestions.
      // Provide a meaningful status message so the responder can ask for a more precise pickup address.
      if (state.locationLookupFailed && validatedDraft.pickupLocation) {
        return {
          draft: validatedDraft,
          stage: "collecting",
          availableOptions: [],
          lastShownOptions: [],
          statusMessage: this.buildLocationSuggestionText(
            validatedDraft.pickupLocation,
            "pickup",
            state.locationSuggestions ?? [],
          ),
          locationSuggestions: state.locationSuggestions ?? [],
          locationLookupTriggered: true,
          locationLookupFailed: true,
        };
      }

      const missingFields = getMissingRequiredFields(validatedDraft);
      if (missingFields.length > 0) {
        return {
          draft: validatedDraft,
          stage: "collecting",
          availableOptions: [],
          lastShownOptions: [],
          error: null,
          locationSuggestions: [],
          locationLookupTriggered: true,
          locationLookupFailed: false,
        };
      }

      const extractedParams = convertToExtractedParams(validatedDraft);
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
        // Preserve the validated draft and location lookup state
        return {
          draft: validatedDraft,
          availableOptions: [],
          lastShownOptions: [],
          stage: "collecting",
          error: null,
          statusMessage: searchResult.precondition.prompt,
          locationSuggestions: [],
          locationLookupTriggered: true,
          locationLookupFailed: false,
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

      // If no vehicles found, set a status message so the responder can inform the user
      const noResultsMessage = this.buildSearchStatusMessage(
        options.length,
        searchResult.exactMatches.length,
      );

      return {
        draft: validatedDraft,
        availableOptions: options,
        lastShownOptions: options,
        stage: newStage,
        error: null,
        statusMessage: noResultsMessage,
        locationSuggestions: [],
        locationLookupTriggered: true,
        // Clear failed state on successful search - this allows re-search with same location
        locationLookupFailed: false,
      };
    } catch (error) {
      this.logger.error("Search node failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Preserve locationLookupTriggered state - if we reached the catch block,
      // validation may have already succeeded before the error occurred.
      // Setting it to false would cause an unnecessary re-validation on the next turn.
      return {
        stage: "collecting",
        error: LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE,
        availableOptions: [],
        lastShownOptions: [],
        statusMessage:
          "I couldn't complete the car search right now. Please try again in a moment, and I'll search again.",
      };
    }
  }

  private buildSearchStatusMessage(optionsCount: number, exactMatchCount: number): string | null {
    if (optionsCount === 0) {
      return "No vehicles matching your criteria are available for the selected date. Would you like to try a different date, vehicle type, or booking type?";
    }

    if (exactMatchCount === 0) {
      return "I couldn't find an exact match, but I found close alternatives you can choose from.";
    }

    return null;
  }

  private async respondNode(state: AnnotationState): Promise<Partial<AnnotationState>> {
    try {
      if (state.outboxItems.length > 0 && state.response) {
        return {};
      }

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

  private buildLocationSuggestionText(
    locationValue: string,
    locationLabel: "pickup" | "drop-off" = "pickup",
    suggestions: BookingAgentState["locationSuggestions"] = [],
  ): string {
    const locationNoun = locationLabel === "pickup" ? "pickup location" : "drop-off location";
    if (suggestions.length === 0) {
      return `I couldn't find "${locationValue}" on Google Maps. Please share a more specific ${locationNoun} (for example: street + area in Lagos).`;
    }

    const list = suggestions.slice(0, 4).map((suggestion, index) => {
      return `${index + 1}. ${suggestion.description}`;
    });
    return [
      `I couldn't find an exact Google Maps match for "${locationValue}".`,
      "",
      "Did you mean one of these?",
      ...list,
      "",
      `Reply with the full address you want from the list, or send a clearer ${locationNoun}.`,
    ].join("\n");
  }

  private buildAreaOnlyLocationPrompt(
    locationValue: string,
    locationLabel: "pickup" | "drop-off" = "pickup",
  ): string {
    const locationNoun = locationLabel === "pickup" ? "pickup address" : "drop-off address";
    return [
      `"${locationValue}" looks like a general area, not a full ${locationNoun}.`,
      "",
      `Please share a specific ${locationNoun} (for example: building number + street, or a hotel/landmark name in Lagos).`,
    ].join("\n");
  }

  private async validateAndNormalizeLocations(state: AnnotationState): Promise<{
    draft: BookingDraft;
    earlyReturn?: Partial<AnnotationState>;
  }> {
    const pickupResult = await this.validateAndNormalizePickupLocation(state);
    if (pickupResult.earlyReturn) {
      return pickupResult;
    }

    return this.validateAndNormalizeDropoffLocation(state, pickupResult.draft);
  }

  private async validateAndNormalizePickupLocation(state: AnnotationState): Promise<{
    draft: BookingDraft;
    earlyReturn?: Partial<AnnotationState>;
  }> {
    const shouldValidate =
      !!state.draft.pickupLocation &&
      (!state.locationLookupTriggered || (state.locationSuggestions ?? []).length > 0);

    if (!shouldValidate) {
      return { draft: state.draft };
    }

    const locationResult = await this.googlePlacesService.validateAddressWithSuggestions(
      state.draft.pickupLocation,
    );

    if (!locationResult.isValid) {
      return {
        draft: state.draft,
        earlyReturn: this.buildInvalidPickupLocationResult(state, locationResult),
      };
    }

    if (!locationResult.normalizedAddress) {
      return { draft: state.draft };
    }

    const wasDropoffSameAsPickup = state.draft.dropoffLocation === state.draft.pickupLocation;
    return {
      draft: {
        ...state.draft,
        pickupLocation: locationResult.normalizedAddress,
        // Keep dropoff in sync if it was auto-filled from pickup via "same location"
        ...(wasDropoffSameAsPickup && {
          dropoffLocation: locationResult.normalizedAddress,
        }),
      },
    };
  }

  private async validateAndNormalizeDropoffLocation(
    state: AnnotationState,
    draft: BookingDraft,
  ): Promise<{
    draft: BookingDraft;
    earlyReturn?: Partial<AnnotationState>;
  }> {
    const pickupLocation = draft.pickupLocation?.trim();
    const dropoffLocation = draft.dropoffLocation?.trim();

    if (!pickupLocation || !dropoffLocation || pickupLocation === dropoffLocation) {
      return { draft };
    }

    const locationResult =
      await this.googlePlacesService.validateAddressWithSuggestions(dropoffLocation);
    if (!locationResult.isValid) {
      return {
        draft,
        earlyReturn: this.buildInvalidDropoffLocationResult(state, dropoffLocation, locationResult),
      };
    }

    if (!locationResult.normalizedAddress) {
      return { draft };
    }

    return {
      draft: {
        ...draft,
        dropoffLocation: locationResult.normalizedAddress,
      },
    };
  }

  private buildInvalidPickupLocationResult(
    state: AnnotationState,
    locationResult: AddressLookupResult,
  ): Partial<AnnotationState> {
    const suggestionText =
      locationResult.failureReason === "AREA_ONLY"
        ? this.buildAreaOnlyLocationPrompt(state.draft.pickupLocation ?? "that location")
        : this.buildLocationSuggestionText(
            state.draft.pickupLocation ?? "that location",
            "pickup",
            [...(locationResult.suggestions ?? [])],
          );

    // Set locationLookupTriggered to true for all failure reasons to prevent infinite
    // re-validation loops. The mergeNode resets this flag when pickupLocationChanged,
    // so re-validation will occur when the user provides a new address.
    const shouldMarkLookupComplete = true;

    // NO_MATCH and AREA_ONLY should mark as failed so searchNode blocks until user provides
    // a new address. AMBIGUOUS has suggestions for the user to choose from, so isn't a failure.
    // AREA_ONLY must also set locationLookupFailed to prevent area-only addresses from
    // bypassing validation and reaching the vehicle search.
    const isLocationFailure =
      locationResult.failureReason === "NO_MATCH" || locationResult.failureReason === "AREA_ONLY";

    return {
      stage: "collecting",
      locationLookupTriggered: shouldMarkLookupComplete,
      locationLookupFailed: isLocationFailure,
      locationSuggestions: (locationResult.suggestions ?? []).map((suggestion) => ({
        placeId: suggestion.placeId,
        description: suggestion.description,
      })),
      response: { text: suggestionText },
      error: null,
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:${state.inboundMessageId}:address-checking`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody: "Thanks - I'm checking that pickup address on Google Maps now...",
        },
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:${state.inboundMessageId}:address-suggestions`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody: suggestionText,
        },
      ],
    };
  }

  private buildInvalidDropoffLocationResult(
    state: AnnotationState,
    dropoffLocation: string,
    locationResult: AddressLookupResult,
  ): Partial<AnnotationState> {
    const suggestionText =
      locationResult.failureReason === "AREA_ONLY"
        ? this.buildAreaOnlyLocationPrompt(dropoffLocation, "drop-off")
        : this.buildLocationSuggestionText(dropoffLocation, "drop-off", [
            ...(locationResult.suggestions ?? []),
          ]);

    return {
      stage: "collecting",
      response: { text: suggestionText },
      error: null,
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:${state.inboundMessageId}:dropoff-address-checking`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody: "Thanks - I'm checking that drop-off address on Google Maps now...",
        },
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:${state.inboundMessageId}:dropoff-address-suggestions`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody: suggestionText,
        },
      ],
    };
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
        bookingInput,
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

      // Keep a user-safe fallback message for unexpected booking failures.
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

  private validateDraftBeforeBookingCreation(draft: BookingDraft): Partial<AnnotationState> | null {
    if (!draft.pickupDate || !draft.dropoffDate || !draft.pickupTime) {
      this.logger.error(
        { draft },
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
