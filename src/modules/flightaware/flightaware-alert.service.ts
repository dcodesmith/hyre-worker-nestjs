import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosInstance } from "axios";
import { formatInTimeZone } from "date-fns-tz";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "src/config/env.config";
import { createHmacSignature } from "../../common/security/webhook-signature.helper";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../http-client/http-client.service";
import { FlightAwareApiException, FlightRecordNotFoundException } from "./flightaware.error";
import type { CreateAlertParams } from "./flightaware.interface";

const ALERT_PROVISIONING_STALE_MS = 2 * 60 * 1000;

type FlightAlertClaim =
  | { kind: "existing"; alertId: string }
  | { kind: "claimed"; claimedAt: Date };

@Injectable()
export class FlightAwareAlertService {
  private readonly apiKey: string;
  private readonly baseUrl = "https://aeroapi.flightaware.com/aeroapi";
  private readonly callbackUrl: string;
  private readonly webhookSecret: string;
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly databaseService: DatabaseService,
    private readonly httpClientService: HttpClientService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FlightAwareAlertService.name);
    this.apiKey = this.configService.get("FLIGHTAWARE_API_KEY", { infer: true });
    const callbackUrl = new URL(
      "/api/webhooks/flightaware",
      this.configService.get("AUTH_BASE_URL", { infer: true }),
    );
    this.callbackUrl = callbackUrl.toString();
    this.webhookSecret = this.configService.get("FLIGHTAWARE_WEBHOOK_SECRET", { infer: true });

    this.httpClient = this.httpClientService.createClient({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        "x-apikey": this.apiKey,
        Accept: "application/json",
      },
      serviceName: "FlightAware",
    });
  }

  async createFlightAlert({
    flightNumber,
    departureTime,
    originCode,
    originTimezone,
    destinationIATA,
    flightId,
  }: CreateAlertParams & { flightId: string }): Promise<string> {
    const resolvedOriginTimezone = await this.resolveOriginTimezone(originCode, originTimezone);
    const dateStr = formatInTimeZone(departureTime, resolvedOriginTimezone, "yyyy-MM-dd");

    this.logger.info({ flightNumber, departureDate: dateStr }, "Creating FlightAware alert");

    const requestBody: Record<string, unknown> = {
      ident: flightNumber.toUpperCase(),
      start: dateStr,
      end: dateStr,
      eta: 0,
      events: {
        arrival: true,
        cancelled: true,
        departure: true,
        diverted: true,
        filed: false,
        out: false,
        off: false,
        on: false,
        in: true,
      },
      target_url: this.buildCallbackUrl(flightId),
    };

    if (destinationIATA) {
      requestBody.destination = destinationIATA;
    }

    try {
      const response = await this.httpClient.post<void>("/alerts", requestBody);
      const alertId = response.headers.location?.match(/\/alerts\/([^/?#]+)/)?.[1];

      if (!alertId) {
        throw new FlightAwareApiException(
          "FlightAware alert response did not include an alert Location",
        );
      }

      this.logger.info({ alertId, flightNumber }, "FlightAware alert created");

      return alertId;
    } catch (error) {
      if (error instanceof FlightAwareApiException) {
        throw error;
      }

      const errorInfo = this.httpClientService.handleError(
        error,
        "createFlightAlert",
        "FlightAware",
      );

      if (errorInfo.status === HttpStatus.UNAUTHORIZED) {
        throw new FlightAwareApiException("FlightAware API authentication failed");
      }

      if (errorInfo.status === HttpStatus.TOO_MANY_REQUESTS) {
        throw new FlightAwareApiException("FlightAware API rate limit exceeded");
      }

      throw new FlightAwareApiException(
        `FlightAware API error: ${errorInfo.status || errorInfo.message}`,
      );
    }
  }

  private buildCallbackUrl(flightId: string): string {
    const callbackUrl = new URL(this.callbackUrl);
    callbackUrl.searchParams.set("flightId", flightId);
    callbackUrl.searchParams.set("signature", createHmacSignature(flightId, this.webhookSecret));
    return callbackUrl.toString();
  }

  private async resolveOriginTimezone(
    originCode?: string,
    originTimezone?: string,
  ): Promise<string> {
    if (originTimezone) {
      return originTimezone;
    }
    if (!originCode) {
      throw new FlightAwareApiException(
        "Origin airport code is required when origin timezone is unavailable",
      );
    }

    try {
      const response = await this.httpClient.get<{ timezone?: string }>(
        `/airports/${encodeURIComponent(originCode)}`,
      );
      if (!response.data.timezone) {
        throw new FlightAwareApiException(
          `FlightAware did not return a timezone for origin airport ${originCode}`,
        );
      }
      return response.data.timezone;
    } catch (error) {
      if (error instanceof FlightAwareApiException) {
        throw error;
      }
      throw new FlightAwareApiException(
        `Unable to resolve timezone for origin airport ${originCode}`,
      );
    }
  }

  async getOrCreateFlightAlert(flightId: string, params: CreateAlertParams): Promise<string> {
    this.logger.info(
      { flightId, flightNumber: params.flightNumber },
      "Getting or creating flight alert",
    );

    const lockId = Array.from(flightId).reduce(
      (acc, char) => (acc * 31 + (char.codePointAt(0) ?? 0)) % 2147483647,
      0,
    );

    const claim = await this.databaseService.$transaction<FlightAlertClaim>(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      const flight = await tx.flight.findUnique({
        where: { id: flightId },
        select: {
          alertId: true,
          alertEnabled: true,
          alertProvisioningAt: true,
        },
      });

      if (!flight) {
        throw new FlightRecordNotFoundException(flightId);
      }

      if (flight.alertId && flight.alertEnabled) {
        return { kind: "existing", alertId: flight.alertId };
      }

      const claimedAt = new Date();
      const staleBefore = claimedAt.getTime() - ALERT_PROVISIONING_STALE_MS;
      if (flight.alertProvisioningAt && flight.alertProvisioningAt.getTime() > staleBefore) {
        throw new Error(`Flight alert provisioning is already in progress for ${flightId}`);
      }

      await tx.flight.update({
        where: { id: flightId },
        data: {
          alertProvisioningAt: claimedAt,
          alertLastAttemptAt: claimedAt,
        },
      });

      return { kind: "claimed", claimedAt };
    });

    if (claim.kind === "existing") {
      this.logger.info(
        { flightId, alertId: claim.alertId },
        "Flight already has active alert, reusing",
      );
      return claim.alertId;
    }

    let createdAlertId: string | null = null;
    try {
      createdAlertId = await this.createFlightAlert({ ...params, flightId });
      const persisted = await this.databaseService.flight.updateMany({
        where: {
          id: flightId,
          alertEnabled: false,
          alertProvisioningAt: claim.claimedAt,
        },
        data: {
          alertId: createdAlertId,
          alertEnabled: true,
          alertCreatedAt: new Date(),
          alertDisabledAt: null,
          alertProvisioningAt: null,
        },
      });
      if (persisted.count !== 1) {
        throw new Error(`Flight alert provisioning claim was lost for ${flightId}`);
      }

      return createdAlertId;
    } catch (error) {
      if (createdAlertId) {
        try {
          await this.disableFlightAlert(createdAlertId);
        } catch (cleanupError) {
          this.logger.error(
            {
              flightId,
              alertId: createdAlertId,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to compensate orphaned FlightAware alert",
          );
        }
      }

      await this.releaseFlightAlertClaim(flightId, claim.claimedAt);
      throw error;
    }
  }

  private async releaseFlightAlertClaim(flightId: string, claimedAt: Date): Promise<void> {
    try {
      await this.databaseService.flight.updateMany({
        where: { id: flightId, alertProvisioningAt: claimedAt },
        data: { alertProvisioningAt: null },
      });
    } catch (error) {
      this.logger.error(
        {
          flightId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to release FlightAware alert provisioning claim",
      );
    }
  }

  async disableFlightAlert(alertId: string): Promise<void> {
    this.logger.info({ alertId }, "Disabling FlightAware alert");

    try {
      await this.httpClient.delete(`/alerts/${alertId}`);
      this.logger.info({ alertId }, "FlightAware alert deleted");
    } catch (error) {
      const errorInfo = this.httpClientService.handleError(
        error,
        "disableFlightAlert",
        "FlightAware",
      );

      if (errorInfo.status === HttpStatus.NOT_FOUND) {
        this.logger.info({ alertId }, "FlightAware alert already deleted");
        return;
      }

      if (errorInfo.status === HttpStatus.UNAUTHORIZED) {
        throw new FlightAwareApiException("FlightAware API authentication failed");
      }

      throw new FlightAwareApiException(
        `FlightAware API error: ${errorInfo.status || errorInfo.message}`,
      );
    }
  }

  async cleanupFlightAlert(flightId: string): Promise<void> {
    this.logger.info({ flightId }, "Cleaning up flight alert");

    const flight = await this.databaseService.flight.findUnique({
      where: { id: flightId },
      select: { alertId: true, alertEnabled: true },
    });

    if (!flight?.alertId || !flight.alertEnabled) {
      this.logger.info({ flightId }, "Flight has no active alert to cleanup");
      return;
    }

    await this.disableFlightAlert(flight.alertId);

    await this.databaseService.flight.update({
      where: { id: flightId },
      data: {
        alertEnabled: false,
        alertCreatedAt: null,
        alertDisabledAt: new Date(),
        alertProvisioningAt: null,
      },
    });

    this.logger.info({ flightId, alertId: flight.alertId }, "Flight alert cleaned up");
  }
}
