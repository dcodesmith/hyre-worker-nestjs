import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { NOTIFICATIONS_QUEUE, REMINDERS_QUEUE, STATUS_UPDATES_QUEUE } from "./config/constants";
import { validateEnvironment } from "./config/env.config";
import { BullBoardModule } from "./modules/bull-board/bull-board.module";
import { DatabaseModule } from "./modules/database/database.module";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
import { JobModule } from "./modules/job/job.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { RedisModule } from "./modules/redis/redis.module";
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
        const url = new URL(redisUrl);

        return {
          redis: {
            host: url.hostname,
            port: parseInt(url.port) || 6379,
            password: url.password || undefined,
            maxRetriesPerRequest: null, // Required by BullMQ
            // Let Redis client auto-detect IP version based on hostname resolution
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: REMINDERS_QUEUE,
    }),
    BullModule.registerQueue({
      name: STATUS_UPDATES_QUEUE,
    }),
    BullModule.registerQueue({
      name: NOTIFICATIONS_QUEUE,
    }),
    RedisModule,
    DatabaseModule,
    FlutterwaveModule,
    NotificationModule,
    PaymentModule,
    ReminderModule,
    StatusChangeModule,
    HealthModule,
    JobModule,
    BullBoardModule,
  ],
})
export class AppModule {}
