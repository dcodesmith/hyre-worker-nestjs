import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PAYOUTS_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { PaymentProcessor } from "./payment.processor";
import { PaymentService } from "./payment.service";

@Module({
  imports: [FlutterwaveModule, DatabaseModule, BullModule.registerQueue({ name: PAYOUTS_QUEUE })],
  providers: [PaymentService, PaymentProcessor],
  exports: [PaymentService],
})
export class PaymentModule {}
