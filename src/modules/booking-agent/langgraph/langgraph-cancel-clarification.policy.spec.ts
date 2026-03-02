import { describe, expect, it } from "vitest";
import { buildState, buildVehicleOption } from "./langgraph.factory";
import {
  CANCEL_CLARIFICATION_CONFIDENCE_THRESHOLD,
  shouldClarifyCancelIntent,
} from "./langgraph-cancel-clarification.policy";

describe("langgraph-cancel-clarification.policy", () => {
  it("clarifies for low-confidence bare cancel during confirming", () => {
    const state = buildState({
      stage: "confirming",
      inboundMessage: "cancel",
      selectedOption: buildVehicleOption(),
      extraction: {
        intent: "cancel",
        draftPatch: {},
        confidence: CANCEL_CLARIFICATION_CONFIDENCE_THRESHOLD - 0.01,
      },
    });

    expect(shouldClarifyCancelIntent(state)).toBe(true);
  });

  it("does not clarify at threshold confidence and above", () => {
    const atThresholdState = buildState({
      stage: "confirming",
      inboundMessage: "cancel",
      selectedOption: buildVehicleOption(),
      extraction: {
        intent: "cancel",
        draftPatch: {},
        confidence: CANCEL_CLARIFICATION_CONFIDENCE_THRESHOLD,
      },
    });

    const aboveThresholdState = buildState({
      stage: "confirming",
      inboundMessage: "cancel",
      selectedOption: buildVehicleOption(),
      extraction: {
        intent: "cancel",
        draftPatch: {},
        confidence: CANCEL_CLARIFICATION_CONFIDENCE_THRESHOLD + 0.01,
      },
    });

    expect(shouldClarifyCancelIntent(atThresholdState)).toBe(false);
    expect(shouldClarifyCancelIntent(aboveThresholdState)).toBe(false);
  });

  it("does not clarify for non-bare cancel phrasing", () => {
    const state = buildState({
      stage: "confirming",
      inboundMessage: "cancel booking",
      selectedOption: buildVehicleOption(),
      extraction: { intent: "cancel", draftPatch: {}, confidence: 0.6 },
    });

    expect(shouldClarifyCancelIntent(state)).toBe(false);
  });
});
