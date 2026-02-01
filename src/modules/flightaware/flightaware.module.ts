import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { FlightAwareService } from "./flightaware.service";
import { FlightAlertProcessor } from "./flightaware-alert.processor";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    BullModule.registerQueue({
      name: FLIGHT_ALERTS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    BullBoardModule.forFeature({
      name: FLIGHT_ALERTS_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [FlightAwareService, FlightAlertProcessor],
  exports: [FlightAwareService, BullModule],
})
export class FlightAwareModule {}
