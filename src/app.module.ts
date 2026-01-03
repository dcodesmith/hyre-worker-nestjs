import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { validateEnvironment } from "./config/env.config";
import { DatabaseModule } from "./modules/database/database.module";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
import { JobModule } from "./modules/job/job.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { ReferralModule } from "./modules/referral/referral.module";
import { ReminderModule } from "./modules/reminder/reminder.module";
import { StatusChangeModule } from "./modules/status-change/status-change.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>("REDIS_URL");

        // If REDIS_URL is provided (local/test), use it
        if (redisUrl) {
          const url = new URL(redisUrl);
          return {
            connection: {
              host: url.hostname,
              port: Number.parseInt(url.port) || 6379,
              password: url.password || undefined,
            },
          };
        }

        // Otherwise, use Upstash (production)
        const upstashUrl = configService.get<string>("UPSTASH_REDIS_REST_URL");
        const upstashToken = configService.get<string>("UPSTASH_REDIS_REST_TOKEN");

        if (!upstashUrl || !upstashToken) {
          throw new Error(
            "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required when REDIS_URL is not provided",
          );
        }

        const url = new URL(upstashUrl);

        return {
          connection: {
            host: url.hostname,
            port: Number.parseInt(url.port) || 6379,
            password: upstashToken,
            tls: {
              rejectUnauthorized: true,
            },
          },
        };
      },
      inject: [ConfigService],
    }),
    BullBoardModule.forRoot({
      route: "/queues",
      adapter: ExpressAdapter,
    }),
    // Queues are registered in their respective feature modules
    DatabaseModule,
    FlutterwaveModule,
    NotificationModule,
    PaymentModule,
    ReminderModule,
    StatusChangeModule,
    HealthModule,
    JobModule,
    ReferralModule,
  ],
})
export class AppModule {}
