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

    const configService = app.get(ConfigService);
    const port = configService.get<number>("PORT");

    await app.listen(port);

    logger.log(`Application started successfully on port ${port}`);
    logger.log(`Server URL: http://localhost:${port}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start application: ${errorMessage}`);
    process.exit(1);
  }
}

bootstrap();
