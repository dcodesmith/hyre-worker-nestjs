import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "./config/env.config";
import { AccountModule } from "./modules/account/account.module";
import { AiSearchModule } from "./modules/ai-search/ai-search.module";
import { AuthModule } from "./modules/auth/auth.module";
import { BookingAgentModule } from "./modules/booking-agent/booking-agent.module";
import { CarModule } from "./modules/car/car.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { DatabaseModule } from "./modules/database/database.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
import { HttpClientModule } from "./modules/http-client/http-client.module";
import { AdminOpsModule } from "./modules/infra/admin-ops/admin-ops.module";
import { ObservabilityModule } from "./modules/infra/observability/observability.module";
import { QueueInfraModule } from "./modules/infra/queue-infra/queue-infra.module";
import { JobModule } from "./modules/job/job.module";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { RatesModule } from "./modules/rates/rates.module";
import { ReferralModule } from "./modules/referral/referral.module";
import { ReminderModule } from "./modules/reminder/reminder.module";
import { ReviewsModule } from "./modules/reviews/reviews.module";
import { StatusChangeModule } from "./modules/status-change/status-change.module";
import { RootController } from "./root.controller";

@Module({
  controllers: [RootController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    ObservabilityModule,
    QueueInfraModule,
    AdminOpsModule,
    // Queues are registered in their respective feature modules
    HttpClientModule,
    DatabaseModule,
    AiSearchModule,
    AccountModule,
    FlutterwaveModule,
    DocumentsModule,
    MessagingModule,
    BookingAgentModule,
    NotificationModule,
    PaymentModule,
    ReminderModule,
    StatusChangeModule,
    HealthModule,
    JobModule,
    ReferralModule,
    ReviewsModule,
    AuthModule,
    CarModule,
    DashboardModule,
    RatesModule,
  ],
})
export class AppModule {}
