import { describe, expect, it } from "vitest";
import { createExtensionBodySchema } from "./create-extension.dto";

describe("createExtensionBodySchema", () => {
  const validBody = {
    hours: 2,
    callbackUrl: "https://example.com/callback",
  };

  it("accepts a body without bookingLegId for backward compatibility", () => {
    expect(createExtensionBodySchema.parse(validBody).bookingLegId).toBeUndefined();
  });

  it("accepts an optional bookingLegId", () => {
    expect(
      createExtensionBodySchema.parse({ ...validBody, bookingLegId: "leg-future" }).bookingLegId,
    ).toBe("leg-future");
  });

  it("rejects an empty bookingLegId", () => {
    const result = createExtensionBodySchema.safeParse({
      ...validBody,
      bookingLegId: "",
    });

    expect(result.success).toBe(false);
  });
});
