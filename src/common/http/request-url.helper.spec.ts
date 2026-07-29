import { describe, expect, it } from "vitest";
import { stripQueryString } from "./request-url.helper";

describe("stripQueryString", () => {
  it("removes query parameters from logged URLs", () => {
    expect(stripQueryString("/api/webhooks/flightaware?secret=sensitive")).toBe(
      "/api/webhooks/flightaware",
    );
  });

  it("preserves paths without a query and undefined values", () => {
    expect(stripQueryString("/health")).toBe("/health");
    expect(stripQueryString(undefined)).toBeUndefined();
  });
});
