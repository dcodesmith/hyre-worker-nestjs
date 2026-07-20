import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseModule } from "../database/database.module";
import { FlightAwareController } from "./flightaware.controller";
import { FlightAwareService } from "./flightaware.service";
import { FlightAlertProcessor } from "./flightaware-alert.processor";
import { FlightAwareAlertService } from "./flightaware-alert.service";
import { FLIGHTAWARE_REDIS_CLIENT, FlightAwareCacheService } from "./flightaware-cache.service";
import { FlightAwareWebhookService } from "./flightaware-webhook.service";
import { FlightAwareWebhookGuard } from "./guards/flightaware-webhook.guard";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    BullModule.registerQueue({
      name: FLIGHT_ALERTS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    BullBoardModule.forFeature({
      name: FLIGHT_ALERTS_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [FlightAwareController],
  providers: [
    {
      provide: FLIGHTAWARE_REDIS_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (configService: ConfigService<EnvConfig>, logger: PinoLogger) => {
        logger.setContext("FlightAwareRedisClient");
        const redisUrl = configService.get("REDIS_URL", { infer: true });
        const client = new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          commandTimeout: 2000,
        });
        client.on("error", (error) => {
          logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            "FLIGHTAWARE_REDIS_CLIENT emitted Redis error",
          );
        });
        return client;
      },
    },
    FlightAwareCacheService,
    FlightAwareService,
    FlightAwareAlertService,
    FlightAlertProcessor,
    FlightAwareWebhookService,
    FlightAwareWebhookGuard,
  ],
  exports: [FlightAwareService, FlightAwareAlertService, BullModule],
})
export class FlightAwareModule {}
