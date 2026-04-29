import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosInstance } from "axios";
import { format } from "date-fns";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "src/config/env.config";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../http-client/http-client.service";
import { FlightAwareApiException, FlightRecordNotFoundException } from "./flightaware.error";
import type { CreateAlertParams, FlightAwareAlertResponse } from "./flightaware.interface";

@Injectable()
export class FlightAwareAlertService {
  private readonly apiKey: string;
  private readonly baseUrl = "https://aeroapi.flightaware.com/aeroapi";
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly databaseService: DatabaseService,
    private readonly httpClientService: HttpClientService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FlightAwareAlertService.name);
    this.apiKey = this.configService.get("FLIGHTAWARE_API_KEY", { infer: true });

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
    flightDate,
    destinationIATA,
    events = ["arrival", "cancelled", "departure", "diverted"],
  }: CreateAlertParams): Promise<string> {
    const dateStr = format(flightDate, "yyyy-MM-dd");

    this.logger.info({ flightNumber, flightDate: dateStr, events }, "Creating FlightAware alert");

    const requestBody: Record<string, unknown> = {
      ident: flightNumber.toUpperCase(),
      date_start: dateStr,
      date_end: dateStr,
      enabled: true,
      events,
    };

    if (destinationIATA) {
      requestBody.destination = destinationIATA;
    }

    try {
      const response = await this.httpClient.post<FlightAwareAlertResponse>("/alerts", requestBody);

      this.logger.info(
        { alertId: response.data.alert_id, flightNumber: response.data.ident },
        "FlightAware alert created",
      );

      return response.data.alert_id;
    } catch (error) {
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

  async getOrCreateFlightAlert(flightId: string, params: CreateAlertParams): Promise<string> {
    this.logger.info(
      { flightId, flightNumber: params.flightNumber },
      "Getting or creating flight alert",
    );

    const lockId = Array.from(flightId).reduce(
      (acc, char) => (acc * 31 + (char.codePointAt(0) ?? 0)) % 2147483647,
      0,
    );

    return this.databaseService.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_lock(${lockId})`;

      try {
        const flight = await tx.flight.findUnique({
          where: { id: flightId },
          select: { alertId: true, alertEnabled: true },
        });

        if (!flight) {
          throw new FlightRecordNotFoundException(flightId);
        }

        if (flight.alertId && flight.alertEnabled) {
          this.logger.info(
            { flightId, alertId: flight.alertId },
            "Flight already has active alert, reusing",
          );
          return flight.alertId;
        }

        const alertId = await this.createFlightAlert(params);

        await tx.flight.update({
          where: { id: flightId },
          data: { alertId, alertEnabled: true },
        });

        return alertId;
      } finally {
        await tx.$executeRaw`SELECT pg_advisory_unlock(${lockId})`;
      }
    });
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
      data: { alertEnabled: false },
    });

    this.logger.info({ flightId, alertId: flight.alertId }, "Flight alert cleaned up");
  }
}
