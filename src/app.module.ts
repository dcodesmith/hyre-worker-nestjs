import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { validateEnvironment } from "./config/env.config";
import { DatabaseModule } from "./modules/database/database.module";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
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
            family: url.protocol === "rediss:" ? 6 : 4, // Force IPv6 for rediss://, IPv4 for redis://
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: "reminder-emails",
    }),
    BullModule.registerQueue({
      name: "status-updates",
    }),
    BullModule.registerQueue({
      name: "notifications",
    }),
    RedisModule,
    DatabaseModule,
    FlutterwaveModule,
    NotificationModule,
    PaymentModule,
    ReminderModule,
    StatusChangeModule,
    HealthModule,
  ],
})
export class AppModule {}
