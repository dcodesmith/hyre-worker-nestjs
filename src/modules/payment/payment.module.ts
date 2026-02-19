import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PAYOUTS_QUEUE } from "../../config/constants";
import { AuthModule } from "../auth/auth.module";
import { BookingModule } from "../booking/booking.module";
import { DatabaseModule } from "../database/database.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { ChargeCompletedHandler } from "./charge-completed.handler";
import { PaymentController } from "./payment.controller";
import { PaymentProcessor } from "./payment.processor";
import { PaymentService } from "./payment.service";
import { PaymentApiService } from "./payment-api.service";
import { PaymentWebhookService } from "./payment-webhook.service";
import { RefundCompletedHandler } from "./refund-completed.handler";
import { TransferCompletedHandler } from "./transfer-completed.handler";

@Module({
  imports: [
    FlutterwaveModule,
    DatabaseModule,
    AuthModule,
    BookingModule,
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
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentApiService,
    PaymentWebhookService,
    PaymentProcessor,
    ChargeCompletedHandler,
    TransferCompletedHandler,
    RefundCompletedHandler,
  ],
  exports: [PaymentService, PaymentApiService, PaymentWebhookService],
})
export class PaymentModule {}
