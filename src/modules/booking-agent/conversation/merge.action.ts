import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { applyDerivedDraftFields, hasDraftChanged, shouldApplyDraftPatch } from "./booking-rules";
import {
  type BookingAgentLocationValidationState,
  type BookingAgentState,
  createDefaultLocationValidationState,
} from "./conversation.interface";

@Injectable()
export class MergeAction {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(MergeAction.name);
  }

  run(state: BookingAgentState): Partial<BookingAgentState> {
    const { extraction, draft, preferences } = state;

    if (!extraction) {
      return {};
    }

    const shouldUpdateDraft = shouldApplyDraftPatch(extraction.intent);
    const baseDraft = shouldUpdateDraft ? { ...draft, ...extraction.draftPatch } : { ...draft };
    const newDraft = shouldUpdateDraft
      ? applyDerivedDraftFields(baseDraft, state.inboundMessage, extraction.draftPatch)
      : baseDraft;
    if (extraction.clarificationPrompt) {
      delete newDraft.durationDays;
      delete newDraft.dropoffDate;
    }

    const newPreferences = this.mergePreferencesWithHint(preferences, extraction.preferenceHint);

    const draftChanged = extraction.intent !== "select_option" && hasDraftChanged(draft, newDraft);
    const pickupLocationChanged = draft.pickupLocation !== newDraft.pickupLocation;
    const dropoffLocationChanged = draft.dropoffLocation !== newDraft.dropoffLocation;

    this.logger.debug(
      {
        autoFilledDropoffLocation: !draft.dropoffLocation && !!newDraft.dropoffLocation,
        autoFilledDropoffDate: !draft.dropoffDate && !!newDraft.dropoffDate,
        hasPickupLocation: !!newDraft.pickupLocation,
        hasDropoffLocation: !!newDraft.dropoffLocation,
        hasFlightNumber: !!newDraft.flightNumber,
        draftChanged,
      },
      "Merge action completed",
    );

    const nextLocationValidation = this.nextLocationValidationOnDraftMerge(
      state.locationValidation,
      pickupLocationChanged,
      dropoffLocationChanged,
    );

    return {
      draft: newDraft,
      preferences: newPreferences,
      stage: draftChanged ? "collecting" : state.stage,
      availableOptions: draftChanged ? [] : state.availableOptions,
      lastShownOptions: draftChanged ? [] : state.lastShownOptions,
      selectedOption: draftChanged ? null : state.selectedOption,
      availableAddons: draftChanged ? [] : (state.availableAddons ?? []),
      selectedAddonIds: draftChanged ? [] : (state.selectedAddonIds ?? []),
      addonSelectionIndex: draftChanged ? 0 : (state.addonSelectionIndex ?? 0),
      requiresFullTank: draftChanged ? false : (state.requiresFullTank ?? false),
      useCredits: draftChanged ? 0 : (state.useCredits ?? 0),
      pricingPreview: draftChanged ? null : (state.pricingPreview ?? null),
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
