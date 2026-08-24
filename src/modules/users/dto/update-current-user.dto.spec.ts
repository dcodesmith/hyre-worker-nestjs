import { describe, expect, it } from "vitest";
import { updateCurrentUserBodySchema } from "./update-current-user.dto";

describe("updateCurrentUserBodySchema", () => {
  it("accepts a partial profile update", () => {
    const parsed = updateCurrentUserBodySchema.safeParse({
      city: "Lagos",
      marketingConsent: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        city: "Lagos",
        marketingConsent: true,
      });
    }
  });

  it("trims strings and treats empty strings as null", () => {
    const parsed = updateCurrentUserBodySchema.safeParse({
      name: "  Ada Lovelace  ",
      phoneNumber: "   ",
      address: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        name: "Ada Lovelace",
        phoneNumber: null,
        address: null,
      });
    }
  });

  it("rejects an empty body", () => {
    const parsed = updateCurrentUserBodySchema.safeParse({});

    expect(parsed.success).toBe(false);
  });

  it("rejects email and other unknown fields", () => {
    const parsed = updateCurrentUserBodySchema.safeParse({
      name: "Ada",
      email: "ada@example.com",
    });

    expect(parsed.success).toBe(false);
  });
});
