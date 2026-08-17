import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { STATUS_UPDATES_QUEUE } from "../../config/constants";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { DomainOutboxModule } from "../domain-outbox/domain-outbox.module";
import { NotificationModule } from "../notification/notification.module";
import {
  AirportTripCompletionPageController,
  FleetOwnerAirportTripCompletionController,
} from "./airport-trip-completion.controller";
import { StatusChangeProcessor } from "./status-change.processor";
import { StatusChangeScheduler } from "./status-change.scheduler";
import { StatusChangeService } from "./status-change.service";
import { StatusChangeEventsListener } from "./status-change-events.listener";
import { StatusChangeSchedulingService } from "./status-change-scheduling.service";

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    NotificationModule,
    DomainOutboxModule,
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 10 }]),
    BullModule.registerQueue({ name: STATUS_UPDATES_QUEUE }),
    BullBoardModule.forFeature({
      name: STATUS_UPDATES_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [AirportTripCompletionPageController, FleetOwnerAirportTripCompletionController],
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
