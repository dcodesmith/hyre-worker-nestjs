import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  try {
    logger.log("Starting application...");

    const app = await NestFactory.create(AppModule);

    app.enableShutdownHooks();
    const configService = app.get(ConfigService);
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
