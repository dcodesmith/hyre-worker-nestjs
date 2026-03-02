import type { BookingAgentState } from "./langgraph.interface";
import { isBareCancelControl, normalizeControlText } from "./langgraph-control-intent.policy";

export const CANCEL_CLARIFICATION_CONFIDENCE_THRESHOLD = 0.85;

export function shouldClarifyCancelIntent(state: BookingAgentState): boolean {
  if (state.stage !== "confirming" || !state.selectedOption || !state.extraction) {
    return false;
  }

  if (state.extraction.intent !== "cancel") {
    return false;
  }

  if (state.extraction.confidence >= CANCEL_CLARIFICATION_CONFIDENCE_THRESHOLD) {
    return false;
  }

  return isBareCancelControl(normalizeControlText(state.inboundMessage));
}
