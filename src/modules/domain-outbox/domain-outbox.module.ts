import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { DOMAIN_OUTBOX_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { PaymentModule } from "../payment/payment.module";
import { ReferralModule } from "../referral/referral.module";
import { DomainOutboxProcessor } from "./domain-outbox.processor";
import { DomainOutboxScheduler } from "./domain-outbox.scheduler";
import { DomainOutboxService } from "./domain-outbox.service";

@Module({
  imports: [
    DatabaseModule,
    ReferralModule,
    PaymentModule,
    BullModule.registerQueue({ name: DOMAIN_OUTBOX_QUEUE }),
    BullBoardModule.forFeature({
      name: DOMAIN_OUTBOX_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [DomainOutboxService, DomainOutboxScheduler, DomainOutboxProcessor],
  exports: [DomainOutboxService],
})
export class DomainOutboxModule {}
