import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { PaymentService } from "./payment.service";

@Module({
  imports: [FlutterwaveModule, DatabaseModule],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
