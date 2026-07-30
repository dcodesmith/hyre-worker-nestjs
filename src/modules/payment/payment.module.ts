import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingModule } from "../booking/booking.module";
import { DatabaseModule } from "../database/database.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { ChargeCompletedHandler } from "./charge-completed.handler";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { PaymentApiService } from "./payment-api.service";
import { PaymentReconciliationService } from "./payment-reconciliation.service";
import { PaymentWebhookService } from "./payment-webhook.service";
import { RefundCompletedHandler } from "./refund-completed.handler";
import { TransferCompletedHandler } from "./transfer-completed.handler";

@Module({
  imports: [FlutterwaveModule, DatabaseModule, AuthModule, BookingModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentApiService,
    PaymentWebhookService,
    PaymentReconciliationService,
    ChargeCompletedHandler,
    TransferCompletedHandler,
    RefundCompletedHandler,
  ],
  exports: [PaymentService, PaymentApiService, PaymentWebhookService],
})
export class PaymentModule {}
