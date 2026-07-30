import { describe, expect, it } from "vitest";
import { classifyRefundProviderStatus } from "./refund-status";

describe("classifyRefundProviderStatus", () => {
  it.each([
    "completed-bank-transfer",
    "completed-momo",
    "completed-mpgs",
    "completed-offline",
    "completed-preauth",
  ])("classifies %s as successful", (status) => {
    expect(classifyRefundProviderStatus(status)).toBe("SUCCEEDED");
  });

  it.each(["completed", "pending-momo", "processing"])("classifies %s as pending", (status) => {
    expect(classifyRefundProviderStatus(status)).toBe("PENDING");
  });

  it.each(["failed", "cancelled", "rejected"])("classifies %s as failed", (status) => {
    expect(classifyRefundProviderStatus(status)).toBe("FAILED");
  });

  it("does not infer success from an undocumented completed prefix", () => {
    expect(classifyRefundProviderStatus("completed-unknown")).toBe("UNKNOWN");
  });
});
