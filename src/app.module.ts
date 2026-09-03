import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ThrottlerModule } from "@nestjs/throttler";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { validateEnvironment } from "./config/env.config";
import { AccountModule } from "./modules/account/account.module";
import { AiSearchModule } from "./modules/ai-search/ai-search.module";
import { AI_SEARCH_THROTTLE_CONFIG } from "./modules/ai-search/ai-search-throttling.config";
import { AuthModule } from "./modules/auth/auth.module";
import { BookingAgentModule } from "./modules/booking-agent/booking-agent.module";
import { CarModule } from "./modules/car/car.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { DatabaseModule } from "./modules/database/database.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { FLIGHT_SEARCH_THROTTLE_CONFIG } from "./modules/flightaware/flightaware-throttling.config";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
import { HttpClientModule } from "./modules/http-client/http-client.module";
import { AdminOpsModule } from "./modules/infra/admin-ops/admin-ops.module";
import { ObservabilityModule } from "./modules/infra/observability/observability.module";
import { QueueInfraModule } from "./modules/infra/queue-infra/queue-infra.module";
import { JobModule } from "./modules/job/job.module";
import { JOB_THROTTLE_CONFIG } from "./modules/job/job-throttling.config";
import { TRIP_DURATION_THROTTLE_CONFIG } from "./modules/maps/maps-throttling.config";
import { PLACES_THROTTLE_CONFIG } from "./modules/maps/places-throttling.config";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { PromotionModule } from "./modules/promotion/promotion.module";
import { RatesModule } from "./modules/rates/rates.module";
import { ReferralModule } from "./modules/referral/referral.module";
import { REFERRAL_THROTTLE_CONFIG } from "./modules/referral/referral-throttling.config";
import { ReminderModule } from "./modules/reminder/reminder.module";
import { ReviewsModule } from "./modules/reviews/reviews.module";
import { StatusChangeModule } from "./modules/status-change/status-change.module";
import { UsersModule } from "./modules/users/users.module";
import { RootController } from "./root.controller";

@Module({
  controllers: [RootController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60_000,
        limit: 10,
      },
      {
        name: JOB_THROTTLE_CONFIG.name,
        ttl: JOB_THROTTLE_CONFIG.ttlMs,
        limit: JOB_THROTTLE_CONFIG.limit,
      },
      {
        name: AI_SEARCH_THROTTLE_CONFIG.name,
        ttl: AI_SEARCH_THROTTLE_CONFIG.ttlMs,
        limit: AI_SEARCH_THROTTLE_CONFIG.limit,
      },
      {
        name: PLACES_THROTTLE_CONFIG.name,
        ttl: PLACES_THROTTLE_CONFIG.ttlMs,
        limit: PLACES_THROTTLE_CONFIG.limits.autocomplete,
      },
      {
        name: TRIP_DURATION_THROTTLE_CONFIG.name,
        ttl: TRIP_DURATION_THROTTLE_CONFIG.ttlMs,
        limit: TRIP_DURATION_THROTTLE_CONFIG.limit,
      },
      {
        name: FLIGHT_SEARCH_THROTTLE_CONFIG.name,
        ttl: FLIGHT_SEARCH_THROTTLE_CONFIG.ttlMs,
        limit: FLIGHT_SEARCH_THROTTLE_CONFIG.limit,
      },
      {
        name: REFERRAL_THROTTLE_CONFIG.name,
        ttl: REFERRAL_THROTTLE_CONFIG.ttlMs,
        limit: REFERRAL_THROTTLE_CONFIG.userLimit,
      },
    ]),
    ObservabilityModule,
    QueueInfraModule,
    AdminOpsModule,
    // Queues are registered in their respective feature modules
    HttpClientModule,
    DatabaseModule,
    AiSearchModule,
    AccountModule,
    UsersModule,
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
    PromotionModule,
  ],
})
export class AppModule {}
