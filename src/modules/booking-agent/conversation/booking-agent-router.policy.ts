import { getMissingRequiredFields } from "../booking-agent.helper";
import { BOOKING_AGENT_ACTIONS } from "./conversation.const";
import type {
  BookingAgentState,
  BookingAgentRouteDecision,
  VehicleSearchOption,
} from "./conversation.interface";
import { shouldClarifyCancelIntent } from "./cancel-clarification.policy";
import {
  isLikelyAffirmativeControl,
  isLikelyNegativeControl,
  normalizeControlText,
} from "./control-intent.policy";

export function resolveRouteDecision(state: BookingAgentState): BookingAgentRouteDecision {
  const { extraction, draft, availableOptions } = state;
  const missingFields = getMissingRequiredFields(draft);

  if (!extraction) {
    return { nextAction: BOOKING_AGENT_ACTIONS.RESPOND, stage: "collecting" };
  }

  const intentDecision = resolveIntentDecision(state);
  if (intentDecision) {
    return intentDecision;
  }

  const stageGuard = getDeterministicStageGuard(state);
  if (stageGuard) {
    return stageGuard;
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
  if (state.stage !== "confirming" || !state.selectedOption) {
    return null;
  }

  const normalizedMessage = normalizeControlText(state.inboundMessage);
  if (isLikelyAffirmativeControl(normalizedMessage)) {
    return { nextAction: BOOKING_AGENT_ACTIONS.CREATE_BOOKING };
  }

  if (isLikelyNegativeControl(normalizedMessage)) {
    return {
      nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
      stage: "collecting",
      selectedOption: null,
      availableOptions: [],
    };
  }

  return null;
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
      return selectedOption ? { nextAction: BOOKING_AGENT_ACTIONS.CREATE_BOOKING } : null;
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
    nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
    stage: "confirming",
    selectedOption: selected,
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
      availableOptions: [],
      lastShownOptions: [],
    };
  }

  return {
    nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
    stage: "collecting",
    selectedOption: null,
    availableOptions: [],
    lastShownOptions: [],
  };
}
