import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { ReferralModule } from "../referral/referral.module";
import { PaymentModule } from "./payment.module";
import { RefundFinalizationService } from "./refund-finalization.service";

describe("PaymentModule", () => {
  it("imports ReferralModule so refund finalization can release stranded rewards", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, PaymentModule)).toEqual(
      expect.arrayContaining([ReferralModule]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentModule)).toEqual(
      expect.arrayContaining([RefundFinalizationService]),
    );
  });
});
