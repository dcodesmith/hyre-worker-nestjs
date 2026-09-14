import { describe, expect, it } from "vitest";
import { generateAuthId } from "./auth.config";

describe("generateAuthId", () => {
  it("generates unique UUIDv7 identifiers", () => {
    const first = generateAuthId();
    const second = generateAuthId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
