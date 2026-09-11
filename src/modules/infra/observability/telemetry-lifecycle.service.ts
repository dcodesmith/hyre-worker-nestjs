import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { flushSentry } from "../../../sentry";
import { shutdownOpenTelemetry } from "../../../tracing";

@Injectable()
export class TelemetryLifecycleService implements OnApplicationShutdown {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(TelemetryLifecycleService.name);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      flushSentry().catch(() => this.logger.error("Failed to flush Sentry during shutdown")),
      shutdownOpenTelemetry().catch(() =>
        this.logger.error("Failed to shut down OpenTelemetry during shutdown"),
      ),
    ]);
  }
}
