import { describe, expect, it } from "vitest";
import {
  isAgentRequestControl,
  isCancelIntentControl,
  isLikelyAffirmativeControl,
  isLikelyNegativeControl,
  normalizeControlText,
} from "./langgraph-control-intent.policy";

describe("langgraph-control-intent.policy", () => {
  it("normalizes punctuation and whitespace", () => {
    expect(normalizeControlText("  Yes,   please!!! ")).toBe("yes please");
  });

  it("detects affirmative control phrases", () => {
    expect(isLikelyAffirmativeControl("yes")).toBe(true);
    expect(isLikelyAffirmativeControl("yes please go ahead")).toBe(true);
    expect(isLikelyAffirmativeControl("okay confirm")).toBe(true);
  });

  it("detects negative control phrases", () => {
    expect(isLikelyNegativeControl("no")).toBe(true);
    expect(isLikelyNegativeControl("no show me another option")).toBe(true);
    expect(isLikelyNegativeControl("not this one")).toBe(true);
  });

  it("detects cancel and agent requests", () => {
    expect(isCancelIntentControl("cancel booking")).toBe(true);
    expect(isAgentRequestControl("talk to agent")).toBe(true);
  });

  it("ignores long free-form text for control parsing", () => {
    const longText =
      "yes this works and also please update pickup to tomorrow evening and change the dropoff location to lekki";
    expect(isLikelyAffirmativeControl(longText)).toBe(false);
    expect(isLikelyNegativeControl(longText)).toBe(false);
  });
});
