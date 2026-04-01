import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { type EnvConfig } from "../../../config/env.config";

@Module({
  imports: [
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
            port: Number.parseInt(url.port, 10) || 6379,
            password: url.password || undefined,
            username: url.username || undefined,
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
  ],
})
export class QueueInfraModule {}
