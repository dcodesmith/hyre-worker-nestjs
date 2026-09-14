import { describe, expect, it } from "vitest";
import { confirmExtensionPaymentSchema } from "./confirm-extension-payment.dto";

describe("confirmExtensionPaymentSchema", () => {
  const extensionId = "01994a1d-4263-7000-8000-000000000001";

  it("accepts an extension callback with a numeric transaction ID", () => {
    expect(
      confirmExtensionPaymentSchema.parse({
        extensionId,
        txRef: "ext-idem-1",
        transactionId: "12345",
      }),
    ).toEqual({
      extensionId,
      txRef: "ext-idem-1",
      transactionId: "12345",
    });
  });

  it("rejects non-numeric transaction IDs", () => {
    expect(
      confirmExtensionPaymentSchema.safeParse({
        extensionId,
        txRef: "ext-idem-1",
        transactionId: "not-a-number",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-UUID extension ID", () => {
    expect(
      confirmExtensionPaymentSchema.safeParse({
        extensionId: "not-a-uuid",
        txRef: "ext-idem-1",
        transactionId: "12345",
      }).success,
    ).toBe(false);
  });
});
