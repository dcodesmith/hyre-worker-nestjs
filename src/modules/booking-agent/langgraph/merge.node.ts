import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { LANGGRAPH_DRAFT_PATCH_MIN_CONFIDENCE } from "./langgraph.const";
import {
  type BookingAgentLocationValidationState,
  type BookingAgentState,
  createDefaultLocationValidationState,
} from "./langgraph.interface";
import {
  applyDerivedDraftFields,
  hasDraftChanged,
  shouldApplyDraftPatch,
} from "./langgraph-booking-rules";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

@Injectable()
export class MergeNode {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(MergeNode.name);
  }

  run(state: LangGraphNodeState): LangGraphNodeResult {
    const { extraction, draft, preferences } = state;

    if (!extraction) {
      return {};
    }

    const applyPatch = shouldApplyDraftPatch(extraction.intent, extraction.confidence);
    const baseDraft = applyPatch ? { ...draft, ...extraction.draftPatch } : { ...draft };
    const newDraft = applyDerivedDraftFields(baseDraft, state.inboundMessage);

    const skipPreferenceMerge =
      extraction.intent === "abuse" ||
      extraction.intent === "unknown" ||
      extraction.intent === "off_topic" ||
      extraction.confidence < LANGGRAPH_DRAFT_PATCH_MIN_CONFIDENCE;
    const newPreferences = skipPreferenceMerge
      ? preferences
      : this.mergePreferencesWithHint(preferences, extraction.preferenceHint);

    const draftChanged = hasDraftChanged(draft, newDraft);
    const pickupLocationChanged = draft.pickupLocation !== newDraft.pickupLocation;
    const dropoffLocationChanged = draft.dropoffLocation !== newDraft.dropoffLocation;
    const shouldClearOptions = draftChanged && state.availableOptions.length > 0;

    this.logger.debug(
      {
        autoFilledDropoffLocation: !draft.dropoffLocation && !!newDraft.dropoffLocation,
        autoFilledDropoffDate: !draft.dropoffDate && !!newDraft.dropoffDate,
        hasPickupLocation: !!newDraft.pickupLocation,
        hasDropoffLocation: !!newDraft.dropoffLocation,
        hasFlightNumber: !!newDraft.flightNumber,
        draftChanged,
      },
      "Merge node completed",
    );

    const nextLocationValidation = this.nextLocationValidationOnDraftMerge(
      state.locationValidation,
      pickupLocationChanged,
      dropoffLocationChanged,
    );

    return {
      draft: newDraft,
      preferences: newPreferences,
      availableOptions: shouldClearOptions ? [] : state.availableOptions,
      lastShownOptions: draftChanged ? [] : state.lastShownOptions,
      locationValidation: nextLocationValidation,
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

    const normalizedHint = preferenceHint.trim().toLowerCase();

    if (normalizedHint === "cheaper" || normalizedHint === "budget") {
      newPreferences.pricePreference = "budget";
    } else if (normalizedHint === "premium" || normalizedHint === "luxury") {
      newPreferences.pricePreference = "premium";
    }

    const existingNotes = newPreferences.notes ?? [];
    newPreferences.notes = existingNotes.some(
      (note) => note.trim().toLowerCase() === normalizedHint,
    )
      ? existingNotes
      : [...existingNotes, normalizedHint];
    return newPreferences;
  }

  private nextLocationValidationOnDraftMerge(
    current: BookingAgentState["locationValidation"],
    pickupLocationChanged: boolean,
    dropoffLocationChanged: boolean,
  ): BookingAgentLocationValidationState {
    const previous = current ?? createDefaultLocationValidationState();
    return {
      pickup: pickupLocationChanged
        ? {
            status: "unvalidated",
            lastValidatedInput: null,
            normalizedAddress: null,
          }
        : previous.pickup,
      dropoff: dropoffLocationChanged
        ? {
            status: "unvalidated",
            lastValidatedInput: null,
            normalizedAddress: null,
          }
        : previous.dropoff,
    };
  }
}
