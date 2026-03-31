import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { RequestIdMiddleware } from "../../../common/middlewares/request-id.middleware";
import { type EnvConfig } from "../../../config/env.config";
import { parseOtlpHeaders } from "../../../config/tracing.config";

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const nodeEnv = configService.get("NODE_ENV", { infer: true });
        const isDev = nodeEnv === "development";
        const isTest = nodeEnv === "test";
        const otlpLogsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
        const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

        if (isTest) {
          return {
            pinoHttp: {
              level: "silent",
            },
          };
        }

        const targets = [];

        if (isDev) {
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
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
