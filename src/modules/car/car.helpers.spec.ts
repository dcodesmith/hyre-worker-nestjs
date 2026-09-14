import { describe, expect, it } from "vitest";
import { CAR_PUBLIC_REF_PATTERN, generateCarPublicRef } from "./car.helpers";

describe("generateCarPublicRef", () => {
  it("generates unique 16-character lowercase hexadecimal references", () => {
    const refs = Array.from({ length: 100 }, generateCarPublicRef);

    expect(refs.every((ref) => CAR_PUBLIC_REF_PATTERN.test(ref))).toBe(true);
    expect(new Set(refs)).toHaveLength(refs.length);
  });
});
