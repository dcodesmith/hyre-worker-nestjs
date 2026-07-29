import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { DatabaseModule } from "../database/database.module";
import { PaymentModule } from "../payment/payment.module";
import { ReferralModule } from "../referral/referral.module";
import { DomainOutboxModule } from "./domain-outbox.module";
import { DomainOutboxProcessor } from "./domain-outbox.processor";
import { DomainOutboxScheduler } from "./domain-outbox.scheduler";
import { DomainOutboxService } from "./domain-outbox.service";

describe("DomainOutboxModule", () => {
  it("wires the dispatcher and its feature producers", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, DomainOutboxModule)).toEqual(
      expect.arrayContaining([DatabaseModule, ReferralModule, PaymentModule]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DomainOutboxModule)).toEqual([
      DomainOutboxService,
      DomainOutboxScheduler,
      DomainOutboxProcessor,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, DomainOutboxModule)).toEqual([
      DomainOutboxService,
    ]);
  });
});
