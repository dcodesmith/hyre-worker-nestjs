import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule } from "nestjs-pino";
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
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const nodeEnv = configService.get("NODE_ENV", { infer: true });
        const isDev = nodeEnv === "development";

        return {
          pinoHttp: {
            level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
            transport: isDev
              ? {
                  target: "pino-pretty",
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: "HH:MM:ss.l",
                    ignore: "pid,hostname",
                  },
                }
              : undefined,
            autoLogging: {
              ignore: (req) => req.url === "/health" || req.url?.startsWith("/queues"),
            },
            customProps: (req) => ({
              requestId: req.headers["x-request-id"],
            }),
          },
        };
      },
      inject: [ConfigService],
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
