import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PAYOUTS_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { PaymentProcessor } from "./payment.processor";
import { PaymentService } from "./payment.service";

@Module({
  imports: [
    FlutterwaveModule,
    DatabaseModule,
    BullModule.registerQueue({
      name: PAYOUTS_QUEUE,
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
      name: PAYOUTS_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [PaymentService, PaymentProcessor],
  exports: [PaymentService],
})
export class PaymentModule {}
