import { getMissingRequiredFields } from "../booking-agent.helper";
import { shouldClarifyCancelIntent } from "./cancel-clarification.policy";
import {
  isLikelyAffirmativeControl,
  isLikelyNegativeControl,
  normalizeControlText,
} from "./control-intent.policy";
import { BOOKING_AGENT_ACTIONS, BOOKING_AGENT_BUTTON_ID } from "./conversation.const";
import type {
  BookingAgentRouteDecision,
  BookingAgentState,
  VehicleSearchOption,
} from "./conversation.interface";

export function resolveRouteDecision(state: BookingAgentState): BookingAgentRouteDecision {
  const { extraction, draft, availableOptions } = state;
  const missingFields = getMissingRequiredFields(draft);

  if (!extraction) {
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "collecting" };
  }

  if (extraction.clarificationPrompt) {
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "collecting" };
  }

  const interactiveGuard = getInteractiveStageGuard(state);
  if (interactiveGuard) {
    return interactiveGuard;
  }

  if (["request_agent", "cancel", "reset", "new_booking", "greeting"].includes(extraction.intent)) {
    const controlDecision = resolveIntentDecision(state);
    if (controlDecision) {
      return controlDecision;
    }
  }

  const stageGuard = getDeterministicStageGuard(state);
  if (stageGuard) {
    return stageGuard;
  }

  const intentDecision = resolveIntentDecision(state);
  if (intentDecision) {
    return intentDecision;
  }

  return resolveFallbackDecision(missingFields.length === 0, availableOptions.length === 0);
}

export function resolveSelection(
  hint: string | undefined,
  options: VehicleSearchOption[],
): VehicleSearchOption | null {
  if (!hint || options.length === 0) {
    return null;
  }

  const hintLower = hint.toLowerCase();
  const ordinalMatch = /^(\d+)(?:st|nd|rd|th)?$/.exec(hintLower);
  if (ordinalMatch) {
    const index = Number.parseInt(ordinalMatch[1], 10) - 1;
    if (index >= 0 && index < options.length) {
      return options[index];
    }
  }

  if (hintLower === "first" || hintLower === "1") return options[0];
  if (hintLower === "second" || hintLower === "2") return options[1];
  if (hintLower === "third" || hintLower === "3") return options[2];

  if (hintLower === "cheapest" || hintLower === "most affordable") {
    return [...options].sort(
      (a, b) =>
        (a.estimatedTotalInclVat ?? Number.POSITIVE_INFINITY) -
        (b.estimatedTotalInclVat ?? Number.POSITIVE_INFINITY),
    )[0];
  }

  if (hintLower === "expensive" || hintLower === "premium" || hintLower === "best") {
    return [...options].sort(
      (a, b) => (b.estimatedTotalInclVat ?? 0) - (a.estimatedTotalInclVat ?? 0),
    )[0];
  }

  const matchById = options.find((o) => o.id === hint);
  if (matchById) return matchById;

  const matchByMake = options.find((o) => o.make.toLowerCase().includes(hintLower));
  if (matchByMake) return matchByMake;

  const matchByModel = options.find((o) => o.model.toLowerCase().includes(hintLower));
  if (matchByModel) return matchByModel;

  const matchByColor = options.find((o) => o.color?.toLowerCase().includes(hintLower));
  if (matchByColor) return matchByColor;

  return null;
}

function getDeterministicStageGuard(state: BookingAgentState): BookingAgentRouteDecision | null {
  const interactiveId = getInteractiveId(state);
  const normalizedMessage = normalizeControlText(state.inboundMessage);

  switch (state.stage) {
    case "selecting_addons":
      return resolveAddonSelection(state, interactiveId, normalizedMessage);
    case "selecting_fuel":
      return resolveFuelSelection(interactiveId, normalizedMessage);
    case "selecting_credits":
      return resolveCreditsSelection(state, interactiveId, normalizedMessage);
    case "confirming":
      return resolveConfirmation(state, interactiveId, normalizedMessage);
    default:
      return null;
  }
}

function getInteractiveStageGuard(state: BookingAgentState): BookingAgentRouteDecision | null {
  const interactiveId = getInteractiveId(state);
  if (!interactiveId) {
    return null;
  }

  switch (state.stage) {
    case "selecting_addons":
    case "selecting_fuel":
    case "selecting_credits":
    case "confirming":
      return getDeterministicStageGuard(state);
    case "collecting":
      return !state.draft.bookingType &&
        (interactiveId === BOOKING_AGENT_BUTTON_ID.DAY ||
          interactiveId === BOOKING_AGENT_BUTTON_ID.NIGHT ||
          interactiveId === BOOKING_AGENT_BUTTON_ID.FULL_DAY)
        ? null
        : { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
    case "presenting_options":
      return state.extraction?.intent === "select_option"
        ? null
        : { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
    case "awaiting_payment":
      return interactiveId === BOOKING_AGENT_BUTTON_ID.CANCEL ||
        interactiveId === BOOKING_AGENT_BUTTON_ID.AGENT
        ? null
        : { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
    default:
      return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
  }
}

function getInteractiveId(state: BookingAgentState): string {
  return state.inboundInteractive?.buttonId ?? state.inboundInteractive?.listRowId ?? "";
}

function resolveAddonSelection(
  state: BookingAgentState,
  interactiveId: string,
  normalizedMessage: string,
): BookingAgentRouteDecision {
  const availableAddons = state.availableAddons ?? [];
  const selectedAddonIds = state.selectedAddonIds ?? [];
  const addonSelectionIndex = state.addonSelectionIndex ?? 0;
  const currentAddon = availableAddons[addonSelectionIndex];
  if (!currentAddon) {
    return { nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE };
  }

  if (interactiveId === BOOKING_AGENT_BUTTON_ID.ADDON_SKIP_ALL) {
    return {
      addonSelectionIndex: availableAddons.length,
      nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
    };
  }

  const shouldAdd =
    interactiveId === `addon_add:${currentAddon.id}` ||
    (!interactiveId &&
      (normalizedMessage === "add" || isLikelyAffirmativeControl(normalizedMessage)));
  const shouldSkip =
    interactiveId === `addon_skip:${currentAddon.id}` ||
    (!interactiveId &&
      (normalizedMessage === "skip" || isLikelyNegativeControl(normalizedMessage)));
  if (!shouldAdd && !shouldSkip) {
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
  }

  return {
    selectedAddonIds: shouldAdd
      ? [...new Set([...selectedAddonIds, currentAddon.id])]
      : selectedAddonIds,
    addonSelectionIndex: addonSelectionIndex + 1,
    nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
  };
}

function resolveFuelSelection(
  interactiveId: string,
  normalizedMessage: string,
): BookingAgentRouteDecision {
  if (
    interactiveId === BOOKING_AGENT_BUTTON_ID.FUEL_APPLY ||
    (!interactiveId &&
      (normalizedMessage === "apply" || isLikelyAffirmativeControl(normalizedMessage)))
  ) {
    return { requiresFullTank: true, nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE };
  }

  if (
    interactiveId === BOOKING_AGENT_BUTTON_ID.FUEL_SKIP ||
    (!interactiveId && (normalizedMessage === "skip" || isLikelyNegativeControl(normalizedMessage)))
  ) {
    return { requiresFullTank: false, nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE };
  }
  return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
}

function resolveCreditsSelection(
  state: BookingAgentState,
  interactiveId: string,
  normalizedMessage: string,
): BookingAgentRouteDecision {
  if (
    interactiveId === BOOKING_AGENT_BUTTON_ID.CREDITS_APPLY ||
    (!interactiveId &&
      (normalizedMessage === "apply" || isLikelyAffirmativeControl(normalizedMessage)))
  ) {
    return {
      useCredits: state.pricingPreview?.creditsApplicable ?? 0,
      nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
    };
  }

  if (
    interactiveId === BOOKING_AGENT_BUTTON_ID.CREDITS_SKIP ||
    (!interactiveId && (normalizedMessage === "skip" || isLikelyNegativeControl(normalizedMessage)))
  ) {
    return { useCredits: 0, nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE };
  }
  return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
}

function resolveConfirmation(
  state: BookingAgentState,
  interactiveId: string,
  normalizedMessage: string,
): BookingAgentRouteDecision | null {
  if (!state.selectedOption) return null;
  if (interactiveId) {
    return resolveInteractiveConfirmation(state, interactiveId);
  }
  if (isLikelyAffirmativeControl(normalizedMessage)) {
    return {
      nextAction: state.pricingPreview
        ? BOOKING_AGENT_ACTIONS.CREATE_BOOKING
        : BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
    };
  }
  if (!isLikelyNegativeControl(normalizedMessage)) return null;

  return {
    nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
    stage: "collecting",
    selectedOption: null,
    availableAddons: [],
    selectedAddonIds: [],
    addonSelectionIndex: 0,
    requiresFullTank: false,
    useCredits: 0,
    pricingPreview: null,
    availableOptions: [],
  };
}

function resolveInteractiveConfirmation(
  state: BookingAgentState,
  interactiveId: string,
): BookingAgentRouteDecision {
  if (interactiveId === BOOKING_AGENT_BUTTON_ID.AGENT) {
    return { nextAction: BOOKING_AGENT_ACTIONS.HANDOFF };
  }
  if (interactiveId === BOOKING_AGENT_BUTTON_ID.CANCEL) {
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "cancelled" };
  }
  if (shouldClarifyCancelIntent(state)) {
    return interactiveId === BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS
      ? buildRejectDecision(state)
      : { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
  }
  if (state.error) {
    if (interactiveId === BOOKING_AGENT_BUTTON_ID.AGENT) {
      return { nextAction: BOOKING_AGENT_ACTIONS.HANDOFF };
    }
    if (interactiveId === BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS) {
      return buildRejectDecision(state);
    }
    if (interactiveId !== BOOKING_AGENT_BUTTON_ID.RETRY_BOOKING) {
      return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
    }
  } else if (interactiveId === BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS) {
    return buildRejectDecision(state);
  } else if (
    interactiveId === BOOKING_AGENT_BUTTON_ID.NO ||
    interactiveId === BOOKING_AGENT_BUTTON_ID.REJECT
  ) {
    return buildRejectDecision(state);
  } else if (
    interactiveId !== BOOKING_AGENT_BUTTON_ID.CONFIRM &&
    interactiveId !== BOOKING_AGENT_BUTTON_ID.YES &&
    interactiveId !== BOOKING_AGENT_BUTTON_ID.RETRY_BOOKING
  ) {
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND };
  }

  return {
    nextAction: state.pricingPreview
      ? BOOKING_AGENT_ACTIONS.CREATE_BOOKING
      : BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
  };
}

function resolveIntentDecision(state: BookingAgentState): BookingAgentRouteDecision | null {
  const { extraction, stage, availableOptions, selectedOption } = state;
  if (!extraction) {
    return null;
  }

  switch (extraction.intent) {
    case "request_agent":
      return { nextAction: BOOKING_AGENT_ACTIONS.HANDOFF };
    case "cancel":
      if (shouldClarifyCancelIntent(state)) {
        return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "confirming" };
      }
      return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "cancelled" };
    case "reset":
      return buildResetDecision();
    case "new_booking":
      return buildNewBookingDecision(extraction.draftPatch);
    case "greeting":
      return buildGreetingDecision(stage);
    case "select_option":
      return buildSelectionDecision(extraction.selectionHint, availableOptions);
    case "confirm":
      return stage === "confirming" && selectedOption
        ? {
            nextAction: state.pricingPreview
              ? BOOKING_AGENT_ACTIONS.CREATE_BOOKING
              : BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
          }
        : null;
    case "reject":
      return buildRejectDecision(state);
    default:
      return null;
  }
}

function resolveFallbackDecision(
  hasNoMissingFields: boolean,
  hasNoAvailableOptions: boolean,
): BookingAgentRouteDecision {
  if (hasNoMissingFields) {
    if (hasNoAvailableOptions) {
      return { nextAction: BOOKING_AGENT_ACTIONS.SEARCH, stage: "searching" };
    }
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "presenting_options" };
  }

  return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "collecting" };
}

function buildResetDecision(): BookingAgentRouteDecision {
  return {
    nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
    stage: "greeting",
    draft: { __clear: true },
    availableOptions: [],
    lastShownOptions: [],
    selectedOption: null,
    availableAddons: [],
    selectedAddonIds: [],
    addonSelectionIndex: 0,
    requiresFullTank: false,
    useCredits: 0,
    pricingPreview: null,
    preferences: { __clear: true },
  };
}

function buildNewBookingDecision(
  draftPatch: Exclude<BookingAgentState["extraction"], null>["draftPatch"],
): BookingAgentRouteDecision {
  return {
    nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
    stage: "collecting",
    draft: { __clear: true, ...draftPatch },
    availableOptions: [],
    lastShownOptions: [],
    selectedOption: null,
    availableAddons: [],
    selectedAddonIds: [],
    addonSelectionIndex: 0,
    requiresFullTank: false,
    useCredits: 0,
    pricingPreview: null,
  };
}

function buildGreetingDecision(stage: BookingAgentState["stage"]): BookingAgentRouteDecision {
  const staleStages = ["completed", "cancelled", "awaiting_payment"];
  if (staleStages.includes(stage)) {
    return {
      nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
      stage: "greeting",
      draft: { __clear: true },
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: null,
      availableAddons: [],
      selectedAddonIds: [],
      addonSelectionIndex: 0,
      requiresFullTank: false,
      useCredits: 0,
      pricingPreview: null,
      preferences: { __clear: true },
    };
  }
  return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "greeting" };
}

function buildSelectionDecision(
  selectionHint: string | undefined,
  availableOptions: VehicleSearchOption[],
): BookingAgentRouteDecision | null {
  if (availableOptions.length === 0) {
    return null;
  }

  const selected = resolveSelection(selectionHint, availableOptions);
  if (!selected) {
    return null;
  }

  return {
    nextAction: BOOKING_AGENT_ACTIONS.PREPARE_QUOTE,
    stage: "selecting_addons",
    selectedOption: selected,
    availableAddons: [],
    selectedAddonIds: [],
    addonSelectionIndex: 0,
    requiresFullTank: false,
    useCredits: 0,
    pricingPreview: null,
  };
}

function buildRejectDecision(state: BookingAgentState): BookingAgentRouteDecision {
  const shouldShowAlternatives = state.extraction?.preferenceHint === "show_alternatives";
  const hasNoMissingFields = getMissingRequiredFields(state.draft).length === 0;
  if (shouldShowAlternatives && hasNoMissingFields) {
    return {
      nextAction: BOOKING_AGENT_ACTIONS.SEARCH,
      stage: "searching",
      selectedOption: null,
      availableAddons: [],
      selectedAddonIds: [],
      addonSelectionIndex: 0,
      requiresFullTank: false,
      useCredits: 0,
      pricingPreview: null,
      availableOptions: [],
      lastShownOptions: [],
    };
  }

  return {
    nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
    stage: "collecting",
    selectedOption: null,
    availableAddons: [],
    selectedAddonIds: [],
    addonSelectionIndex: 0,
    requiresFullTank: false,
    useCredits: 0,
    pricingPreview: null,
    availableOptions: [],
    lastShownOptions: [],
  };
}
