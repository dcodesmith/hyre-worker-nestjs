import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { createBullBoardAuthMiddleware } from "./common/middlewares/bull-board-auth.middleware";
import { validateEnvironment } from "./config/env.config";
import { AuthModule } from "./modules/auth/auth.module";
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
        const url = new URL(redisUrl);
        const isTls = url.protocol === "rediss:";

        return {
          connection: {
            host: url.hostname,
            port: Number.parseInt(url.port) || 6379,
            password: url.password || undefined,
            ...(isTls && {
              tls: {
                rejectUnauthorized: false,
              },
            }),
          },
        };
      },
      inject: [ConfigService],
    }),
    BullBoardModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const bullBoardUsername = configService.get<string>("BULL_BOARD_USERNAME");
        const bullBoardPassword = configService.get<string>("BULL_BOARD_PASSWORD");

        const middleware =
          bullBoardUsername && bullBoardPassword
            ? createBullBoardAuthMiddleware(bullBoardUsername, bullBoardPassword)
            : undefined;

        return {
          route: "/queues",
          adapter: ExpressAdapter,
          middleware,
        };
      },
      inject: [ConfigService],
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
    AuthModule,
  ],
})
export class AppModule {}
