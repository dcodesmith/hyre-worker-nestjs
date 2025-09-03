import { Module } from "@nestjs/common";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { PaymentService } from "./payment.service";

@Module({
  imports: [FlutterwaveModule],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
