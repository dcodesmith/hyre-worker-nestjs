import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingModule } from "../booking/booking.module";
import { DatabaseModule } from "../database/database.module";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { NotificationModule } from "../notification/notification.module";
import { AdminFinancialOperationsController } from "./admin-financial-operations.controller";
import { AdminFinancialOperationsService } from "./admin-financial-operations.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { PaymentApiService } from "./payment-api.service";
import { PaymentReconciliationService } from "./payment-reconciliation.service";
import { PaymentWebhookService } from "./payment-webhook.service";
import { RefundCompletedHandler } from "./refund-completed.handler";
import { RefundFinalizationService } from "./refund-finalization.service";
import { RefundReconciliationService } from "./refund-reconciliation.service";
import { TransferCompletedHandler } from "./transfer-completed.handler";

@Module({
  imports: [FlutterwaveModule, DatabaseModule, AuthModule, BookingModule, NotificationModule],
  controllers: [PaymentController, AdminFinancialOperationsController],
  providers: [
    AdminFinancialOperationsService,
    PaymentService,
    PaymentApiService,
    PaymentWebhookService,
    PaymentReconciliationService,
    ChargeCompletedHandler,
    TransferCompletedHandler,
    RefundCompletedHandler,
    RefundFinalizationService,
    RefundReconciliationService,
  ],
  exports: [PaymentService, PaymentApiService, PaymentWebhookService],
})
export class PaymentModule {}
