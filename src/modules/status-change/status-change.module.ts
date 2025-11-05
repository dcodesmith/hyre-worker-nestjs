import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { STATUS_UPDATES_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { PaymentModule } from "../payment/payment.module";
import { StatusChangeProcessor } from "./status-change.processor";
import { StatusChangeScheduler } from "./status-change.scheduler";
import { StatusChangeService } from "./status-change.service";

@Module({
  imports: [
    DatabaseModule,
    NotificationModule,
    PaymentModule,
    BullModule.registerQueue({ name: STATUS_UPDATES_QUEUE }),
  ],
  providers: [StatusChangeService, StatusChangeProcessor, StatusChangeScheduler],
  exports: [StatusChangeService],
})
export class StatusChangeModule {}
