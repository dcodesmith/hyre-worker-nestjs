import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { createBullBoardAuthMiddleware } from "../../../common/middlewares/bull-board-auth.middleware";
import { type EnvConfig } from "../../../config/env.config";

@Module({
  imports: [
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
  ],
})
export class AdminOpsModule {}
