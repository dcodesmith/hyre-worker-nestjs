import { describe, expect, it } from "vitest";
import { bookingIdParamSchema, createExtensionBodySchema } from "./create-extension.dto";

describe("createExtensionBodySchema", () => {
  const bookingLegId = "01994a1d-4263-7000-8000-000000000001";
  const validBody = {
    hours: 2,
    callbackUrl: "https://example.com/callback",
  };

  it("accepts a body without bookingLegId for backward compatibility", () => {
    expect(createExtensionBodySchema.parse(validBody).bookingLegId).toBeUndefined();
  });

  it("accepts an optional bookingLegId", () => {
    expect(createExtensionBodySchema.parse({ ...validBody, bookingLegId }).bookingLegId).toBe(
      bookingLegId,
    );
  });

  it("rejects an empty bookingLegId", () => {
    const result = createExtensionBodySchema.safeParse({
      ...validBody,
      bookingLegId: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID bookingLegId", () => {
    expect(
      createExtensionBodySchema.safeParse({
        ...validBody,
        bookingLegId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});

describe("bookingIdParamSchema", () => {
  it("accepts UUID booking IDs and rejects malformed IDs", () => {
    expect(bookingIdParamSchema.safeParse("01994a1d-4263-7000-8000-000000000001").success).toBe(
      true,
    );
    expect(bookingIdParamSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
