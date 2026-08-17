import { describe, expect, it } from "vitest";
import {
  createBookingCompletionToken,
  hashBookingCompletionToken,
} from "./booking-completion-token.helper";

describe("booking completion token", () => {
  it("creates a random token and stores only its hash", () => {
    const first = createBookingCompletionToken();
    const second = createBookingCompletionToken();

    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toBe(hashBookingCompletionToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
  });
});
