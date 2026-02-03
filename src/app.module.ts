import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { createBullBoardAuthMiddleware } from "./common/middlewares/bull-board-auth.middleware";
import { RequestIdMiddleware } from "./common/middlewares/request-id.middleware";
import { EnvConfig, validateEnvironment } from "./config/env.config";
import { AuthModule } from "./modules/auth/auth.module";
import { DatabaseModule } from "./modules/database/database.module";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
import { HttpClientModule } from "./modules/http-client/http-client.module";
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
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const redisUrl = configService.get("REDIS_URL", { infer: true });
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
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const bullBoardUsername = configService.get("BULL_BOARD_USERNAME", { infer: true });
        const bullBoardPassword = configService.get("BULL_BOARD_PASSWORD", { infer: true });

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
    HttpClientModule,
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
