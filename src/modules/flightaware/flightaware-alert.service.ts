import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosInstance } from "axios";
import { format } from "date-fns";
import type { EnvConfig } from "src/config/env.config";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../http-client/http-client.service";
import { FlightAwareApiException, FlightRecordNotFoundException } from "./flightaware.error";
import type { CreateAlertParams, FlightAwareAlertResponse } from "./flightaware.interface";

@Injectable()
export class FlightAwareAlertService {
  private readonly logger = new Logger(FlightAwareAlertService.name);
  private readonly apiKey: string;
  private readonly baseUrl = "https://aeroapi.flightaware.com/aeroapi";
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly databaseService: DatabaseService,
    private readonly httpClientService: HttpClientService,
  ) {
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

    this.logger.log("Creating FlightAware alert", {
      flightNumber,
      flightDate: dateStr,
      events,
    });

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

      this.logger.log("FlightAware alert created", {
        alertId: response.data.alert_id,
        flightNumber: response.data.ident,
      });

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
    this.logger.log("Getting or creating flight alert", {
      flightId,
      flightNumber: params.flightNumber,
    });

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
          this.logger.log("Flight already has active alert, reusing", {
            flightId,
            alertId: flight.alertId,
          });
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
    this.logger.log("Disabling FlightAware alert", { alertId });

    try {
      await this.httpClient.delete(`/alerts/${alertId}`);
      this.logger.log("FlightAware alert deleted", { alertId });
    } catch (error) {
      const errorInfo = this.httpClientService.handleError(
        error,
        "disableFlightAlert",
        "FlightAware",
      );

      if (errorInfo.status === HttpStatus.NOT_FOUND) {
        this.logger.log("FlightAware alert already deleted", { alertId });
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
    this.logger.log("Cleaning up flight alert", { flightId });

    const flight = await this.databaseService.flight.findUnique({
      where: { id: flightId },
      select: { alertId: true, alertEnabled: true },
    });

    if (!flight?.alertId || !flight.alertEnabled) {
      this.logger.log("Flight has no active alert to cleanup", { flightId });
      return;
    }

    await this.disableFlightAlert(flight.alertId);

    await this.databaseService.flight.update({
      where: { id: flightId },
      data: { alertEnabled: false },
    });

    this.logger.log("Flight alert cleaned up", { flightId, alertId: flight.alertId });
  }
}
