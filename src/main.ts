import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import type { EnvConfig } from "./config/env.config";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  try {
    logger.log("Starting application...");

    const app = await NestFactory.create<NestExpressApplication>(AppModule);

    const configService = app.get(ConfigService<EnvConfig>);

    // Configure CORS for auth endpoints (if TRUSTED_ORIGINS is set)
    const trustedOrigins = configService.get("TRUSTED_ORIGINS", { infer: true });
    if (trustedOrigins) {
      app.enableCors({
        origin: trustedOrigins,
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
        exposedHeaders: ["Set-Cookie"],
      });
    }

    // Get HttpAdapterHost for platform-agnostic exception filter
    const httpAdapterHost = app.get(HttpAdapterHost);

    // Register global exception filter
    // biome-ignore lint/correctness/useHookAtTopLevel: <nestjs hook, not react>
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    app.enableShutdownHooks();
    const port = configService.get("PORT", { infer: true });
    const host = configService.get("HOST", { infer: true });
    const timezone = configService.get("TZ", { infer: true });

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
