import otelSdk from "./tracing";
import "reflect-metadata";

// Surface unhandled rejections during bootstrap (e.g. Redis/DB connection failures)
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Bootstrap] Unhandled rejection:", reason);
  console.error("Promise:", promise);
});

import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import type { EnvConfig } from "./config/env.config";
import { getDevLanOriginPatterns, isOriginAllowed } from "./modules/auth/origin-pattern";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  try {
    logger.log("Starting application...");

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bufferLogs: true,
    });

    // Use Pino logger for all application logging
    // biome-ignore lint/correctness/useHookAtTopLevel: <nestjs hook, not react>
    app.useLogger(app.get(PinoLogger));

    // Security headers
    app.use(helmet());

    // Bull Board requires inline scripts and styles - apply relaxed CSP
    app.use("/queues", (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:",
      );
      next();
    });

    const configService = app.get(ConfigService<EnvConfig>);

    // Configure CORS for auth endpoints (if TRUSTED_ORIGINS is set).
    // In development we extend the env-configured origins with RFC1918 LAN
    // wildcards so that the mobile app and a web client running on the host
    // machine's LAN IP (e.g. http://192.168.x.x:3000) aren't blocked when the
    // IP changes between sessions. Production keeps strict, exact-origin
    // matching.
    const trustedOrigins = configService.get("TRUSTED_ORIGINS", { infer: true });
    if (trustedOrigins) {
      const nodeEnv = configService.get("NODE_ENV", { infer: true });
      const allowedOriginPatterns = [...trustedOrigins, ...getDevLanOriginPatterns(nodeEnv)];

      app.enableCors({
        origin: (origin, callback) => {
          // Non-browser callers (mobile, server-to-server, curl) don't always
          // send Origin; let those through and rely on auth/CSRF for safety.
          if (!origin) {
            return callback(null, true);
          }
          callback(null, isOriginAllowed(origin, allowedOriginPatterns));
        },
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

    // Register OpenTelemetry SDK shutdown with NestJS lifecycle
    const closeApp = app.close.bind(app);
    app.close = async () => {
      logger.log("Shutting down OpenTelemetry SDK...");
      try {
        await otelSdk.shutdown();
        logger.log("OpenTelemetry SDK shut down successfully");
      } catch (error) {
        logger.error("Error shutting down OpenTelemetry SDK:", error);
      }
      return closeApp();
    };

    const port = configService.get("PORT", { infer: true });
    const host = configService.get("HOST", { infer: true });
    const timezone = configService.get("TZ", { infer: true });

    await app.listen(port, host);

    logger.log(
      `Application started successfully on ${host}:${port} (Timezone: ${timezone}, Current time: ${new Date().toLocaleString("en-US", { timeZone: timezone })})`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`Failed to start application: ${errorMessage}`);
    // Ensure error is visible even if logger hasn't flushed
    console.error(`[Bootstrap] Failed to start:`, errorMessage);
    if (errorStack) console.error(errorStack);
    process.exit(1);
  }
}

bootstrap();
