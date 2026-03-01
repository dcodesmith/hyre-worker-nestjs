import { LANGGRAPH_NODE_NAMES } from "./langgraph.const";
import type {
  BookingAgentState,
  LangGraphRouteDecision,
  VehicleSearchOption,
} from "./langgraph.interface";
import { getMissingRequiredFields } from "./langgraph-booking-rules";
import {
  isLikelyAffirmativeControl,
  isLikelyNegativeControl,
  normalizeControlText,
} from "./langgraph-control-intent.policy";

export function resolveRouteDecision(state: BookingAgentState): LangGraphRouteDecision {
  const { extraction, draft, availableOptions } = state;
  const missingFields = getMissingRequiredFields(draft);

  if (!extraction) {
    return { nextNode: LANGGRAPH_NODE_NAMES.RESPOND, stage: "collecting" };
  }

  const stageGuard = getDeterministicStageGuard(state);
  if (stageGuard) {
    return stageGuard;
  }

  const intentDecision = resolveIntentDecision(state);
  if (intentDecision) {
    return intentDecision;
  }

  return resolveFallbackDecision(
    extraction.intent,
    missingFields.length === 0,
    availableOptions.length === 0,
  );
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

function getDeterministicStageGuard(state: BookingAgentState): LangGraphRouteDecision | null {
  if (!state.selectedOption) {
    return null;
  }

  const normalizedMessage = normalizeControlText(state.inboundMessage);
  if (isLikelyAffirmativeControl(normalizedMessage)) {
    return { nextNode: LANGGRAPH_NODE_NAMES.CREATE_BOOKING };
  }

  if (isLikelyNegativeControl(normalizedMessage)) {
    return {
      nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
      stage: "collecting",
      selectedOption: null,
      availableOptions: [],
    };
  }

  return null;
}

function resolveIntentDecision(state: BookingAgentState): LangGraphRouteDecision | null {
  const { extraction, stage, availableOptions, selectedOption } = state;
  if (!extraction) {
    return null;
  }

  switch (extraction.intent) {
    case "request_agent":
      return { nextNode: LANGGRAPH_NODE_NAMES.HANDOFF };
    case "cancel":
      return { nextNode: LANGGRAPH_NODE_NAMES.RESPOND, stage: "cancelled" };
    case "reset":
      return buildResetDecision();
    case "new_booking":
      return buildNewBookingDecision(extraction.draftPatch);
    case "greeting":
      return buildGreetingDecision(stage);
    case "select_option":
      return buildSelectionDecision(extraction.selectionHint, availableOptions);
    case "confirm":
      return selectedOption ? { nextNode: LANGGRAPH_NODE_NAMES.CREATE_BOOKING } : null;
    case "reject":
      return buildRejectDecision();
    default:
      return null;
  }
}

function resolveFallbackDecision(
  intent: BookingAgentState["extraction"]["intent"],
  hasNoMissingFields: boolean,
  hasNoAvailableOptions: boolean,
): LangGraphRouteDecision {
  if (hasNoMissingFields) {
    if (hasNoAvailableOptions) {
      return { nextNode: LANGGRAPH_NODE_NAMES.SEARCH, stage: "searching" };
    }
    return { nextNode: LANGGRAPH_NODE_NAMES.RESPOND, stage: "presenting_options" };
  }

  if (intent === "confirm") {
    return { nextNode: LANGGRAPH_NODE_NAMES.RESPOND, stage: "collecting" };
  }

  return { nextNode: LANGGRAPH_NODE_NAMES.RESPOND, stage: "collecting" };
}

function buildResetDecision(): LangGraphRouteDecision {
  return {
    nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
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
): LangGraphRouteDecision {
  return {
    nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
    stage: "collecting",
    draft: { __clear: true, ...draftPatch },
    availableOptions: [],
    lastShownOptions: [],
    selectedOption: null,
  };
}

function buildGreetingDecision(stage: BookingAgentState["stage"]): LangGraphRouteDecision {
  const staleStages = ["completed", "cancelled", "awaiting_payment"];
  if (staleStages.includes(stage)) {
    return {
      nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
      stage: "greeting",
      draft: { __clear: true },
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: null,
      preferences: { __clear: true },
    };
  }
  return { nextNode: LANGGRAPH_NODE_NAMES.RESPOND, stage: "greeting" };
}

function buildSelectionDecision(
  selectionHint: string | undefined,
  availableOptions: VehicleSearchOption[],
): LangGraphRouteDecision | null {
  if (availableOptions.length === 0) {
    return null;
  }

  const selected = resolveSelection(selectionHint, availableOptions);
  if (!selected) {
    return null;
  }

  return {
    nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
    stage: "confirming",
    selectedOption: selected,
  };
}

function buildRejectDecision(): LangGraphRouteDecision {
  return {
    nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
    stage: "collecting",
    selectedOption: null,
    availableOptions: [],
  };
}
