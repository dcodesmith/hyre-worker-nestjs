import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { STATUS_UPDATES_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { PaymentModule } from "../payment/payment.module";
import { ReferralModule } from "../referral/referral.module";
import { StatusChangeProcessor } from "./status-change.processor";
import { StatusChangeScheduler } from "./status-change.scheduler";
import { StatusChangeService } from "./status-change.service";
import { StatusChangeEventsListener } from "./status-change-events.listener";
import { StatusChangeSchedulingService } from "./status-change-scheduling.service";

@Module({
  imports: [
    DatabaseModule,
    NotificationModule,
    ReferralModule,
    PaymentModule,
    BullModule.registerQueue({ name: STATUS_UPDATES_QUEUE }),
    BullBoardModule.forFeature({
      name: STATUS_UPDATES_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    StatusChangeService,
    StatusChangeProcessor,
    StatusChangeScheduler,
    StatusChangeSchedulingService,
    StatusChangeEventsListener,
  ],
  exports: [StatusChangeService, BullModule],
})
export class StatusChangeModule {}
