import { describe, expect, it } from "vitest";
import {
  createAddonRateSchema,
  createPlatformFeeSchema,
  createVatRateSchema,
} from "./rates-admin.dto";

describe("rates-admin DTO schemas", () => {
  it("rejects invalid date range for platform fee schema", () => {
    const parsed = createPlatformFeeSchema.safeParse({
      feeType: "PLATFORM_SERVICE_FEE",
      ratePercent: 10,
      effectiveSince: "2026-06-01",
      effectiveUntil: "2026-03-01",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("effectiveSince must be before effectiveUntil");
    }
  });

  it("rejects invalid date range for VAT schema", () => {
    const parsed = createVatRateSchema.safeParse({
      ratePercent: 7.5,
      effectiveSince: "2026-06-01",
      effectiveUntil: "2026-03-01",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("effectiveSince must be before effectiveUntil");
    }
  });

  it("rejects invalid date range for addon schema", () => {
    const parsed = createAddonRateSchema.safeParse({
      addonType: "SECURITY_DETAIL",
      rateAmount: 5000,
      effectiveSince: "2026-06-01",
      effectiveUntil: "2026-03-01",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("effectiveSince must be before effectiveUntil");
    }
  });
});
