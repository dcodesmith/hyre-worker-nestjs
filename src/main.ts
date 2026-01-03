import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  try {
    logger.log("Starting application...");

    const app = await NestFactory.create<NestExpressApplication>(AppModule);

    const configService = app.get(ConfigService);

    // Bull Board authentication is configured in AppModule via BullBoardModule.forRootAsync
    const bullBoardUsername = configService.get<string>("BULL_BOARD_USERNAME");
    const bullBoardPassword = configService.get<string>("BULL_BOARD_PASSWORD");
    if (bullBoardUsername && bullBoardPassword) {
      logger.log("Bull Board authentication enabled");
    }

    // Get HttpAdapterHost for platform-agnostic exception filter
    const httpAdapterHost = app.get(HttpAdapterHost);

    // Register global exception filter
    // biome-ignore lint/correctness/useHookAtTopLevel: <nestjs hook, not react>
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    app.enableShutdownHooks();
    const port = configService.get<number>("PORT", 3000);
    const host = configService.get<string>("HOST", "0.0.0.0");
    const timezone = configService.get<string>("TZ");

    await app.listen(port, host);

    logger.log(
      `Application started successfully on ${host}:${port} (Timezone: ${timezone}, Current time: ${new Date().toLocaleString("en-US", { timeZone: timezone })})`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start application: ${errorMessage}`);
    process.exit(1);
  }
}

bootstrap();
