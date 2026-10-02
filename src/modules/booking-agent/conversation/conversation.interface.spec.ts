import { describe, expect, it } from "vitest";
import { convertToExtractedParams } from "./conversation.interface";

describe("conversation interface helpers", () => {
  it("keeps explicit any make and model choices out of search filters", () => {
    expect(
      convertToExtractedParams({
        vehicleType: "SUV",
        make: "ANY",
        model: "any",
      }),
    ).toEqual(
      expect.objectContaining({
        vehicleType: "SUV",
        make: undefined,
        model: undefined,
      }),
    );
  });
});
