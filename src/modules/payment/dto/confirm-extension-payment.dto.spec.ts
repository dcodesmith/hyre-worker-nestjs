import { describe, expect, it } from "vitest";
import { confirmExtensionPaymentSchema } from "./confirm-extension-payment.dto";

describe("confirmExtensionPaymentSchema", () => {
  it("accepts an extension callback with a numeric transaction ID", () => {
    expect(
      confirmExtensionPaymentSchema.parse({
        extensionId: "extension-1",
        txRef: "ext-idem-1",
        transactionId: "12345",
      }),
    ).toEqual({
      extensionId: "extension-1",
      txRef: "ext-idem-1",
      transactionId: "12345",
    });
  });

  it("rejects non-numeric transaction IDs", () => {
    expect(
      confirmExtensionPaymentSchema.safeParse({
        extensionId: "extension-1",
        txRef: "ext-idem-1",
        transactionId: "not-a-number",
      }).success,
    ).toBe(false);
  });
});
