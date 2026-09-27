import { describe, expect, it } from "vitest";
import { isLikelyGibberish } from "./langgraph-message-quality.policy";

describe("isLikelyGibberish", () => {
  it("rejects keyboard smash without vowels", () => {
    expect(isLikelyGibberish("bcdfghjklmnp")).toBe(true);
    expect(isLikelyGibberish("qwrtypsdfghjkl")).toBe(true);
  });

  it("rejects long repeated characters or tokens", () => {
    expect(isLikelyGibberish("aaaaaaa")).toBe(true);
    expect(isLikelyGibberish("spam spam spam spam spam")).toBe(true);
  });

  it("accepts normal booking language including pidgin and short replies", () => {
    expect(isLikelyGibberish("I wan book motor for VI tomorrow")).toBe(false);
    expect(isLikelyGibberish("yes")).toBe(false);
    expect(isLikelyGibberish("Lekki")).toBe(false);
    expect(isLikelyGibberish("how much for a Prado?")).toBe(false);
  });
});
