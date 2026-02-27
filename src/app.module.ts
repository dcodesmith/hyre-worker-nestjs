import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule } from "nestjs-pino";
import { CommandsModule } from "./commands/commands.module";
import { createBullBoardAuthMiddleware } from "./common/middlewares/bull-board-auth.middleware";
import { RequestIdMiddleware } from "./common/middlewares/request-id.middleware";
import { EnvConfig, validateEnvironment } from "./config/env.config";
import { parseOtlpHeaders } from "./config/tracing.config";
import { AccountModule } from "./modules/account/account.module";
import { AiSearchModule } from "./modules/ai-search/ai-search.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CarModule } from "./modules/car/car.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { DatabaseModule } from "./modules/database/database.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { FlutterwaveModule } from "./modules/flutterwave/flutterwave.module";
import { HealthModule } from "./modules/health/health.module";
import { HttpClientModule } from "./modules/http-client/http-client.module";
import { JobModule } from "./modules/job/job.module";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { RatesModule } from "./modules/rates/rates.module";
import { ReferralModule } from "./modules/referral/referral.module";
import { ReminderModule } from "./modules/reminder/reminder.module";
import { ReviewsModule } from "./modules/reviews/reviews.module";
import { StatusChangeModule } from "./modules/status-change/status-change.module";
import { WhatsAppAgentModule } from "./modules/whatsapp-agent/whatsapp-agent.module";

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
        const isTest = nodeEnv === "test";
        const otlpLogsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
        const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

        // Disable logging in test environment
        if (isTest) {
          return {
            pinoHttp: {
              level: "silent",
            },
          };
        }

        // Build transport targets array
        const targets = [];

        if (isDev) {
          // Development: pretty-print logs to console
          targets.push({
            target: "pino-pretty",
            options: {
              colorize: true,
              singleLine: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname",
            },
            level: process.env.LOG_LEVEL || "debug",
          });
        } else {
          // Production: send logs to OpenTelemetry collector if configured
          if (otlpLogsEndpoint) {
            targets.push({
              target: "pino-opentelemetry-transport",
              options: {
                url: otlpLogsEndpoint,
                headers: otlpHeaders,
                resourceAttributes: {
                  "service.name": process.env.OTEL_SERVICE_NAME || "hyre-worker-nestjs",
                },
              },
              level: process.env.LOG_LEVEL || "info",
            });
          }

          // Production: always write JSON logs to stdout as fallback
          targets.push({
            target: "pino/file",
            options: {},
            level: process.env.LOG_LEVEL || "info",
          });
        }

        return {
          pinoHttp: {
            level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
            transport: targets.length > 0 ? { targets } : undefined,
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
    CommandsModule,
    HttpClientModule,
    DatabaseModule,
    AiSearchModule,
    AccountModule,
    FlutterwaveModule,
    DocumentsModule,
    MessagingModule,
    WhatsAppAgentModule,
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
