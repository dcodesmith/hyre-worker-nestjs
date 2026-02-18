import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosInstance } from "axios";
import { EnvConfig } from "src/config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { FALLBACK_DURATION_MINUTES, LAGOS_AIRPORT_COORDS } from "./maps.const";
import type { DriveTimeResult, GoogleRoutesOrigin, GoogleRoutesResponse } from "./maps.interface";

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly httpClientService: HttpClientService,
  ) {
    this.apiKey = this.configService.get("GOOGLE_DISTANCE_MATRIX_API_KEY", { infer: true });

    this.httpClient = this.httpClientService.createClient({
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      serviceName: "GoogleMaps",
    });
  }

  /**
   * Calculate drive time from Lagos airport to a destination address
   *
   * @param destinationAddress - The destination address (e.g., "Victoria Island, Lagos")
   * @returns Drive time result with duration in minutes
   */
  async calculateAirportTripDuration(destinationAddress: string): Promise<DriveTimeResult> {
    return this.computeRoute(
      { location: { latLng: LAGOS_AIRPORT_COORDS } },
      destinationAddress,
      "calculateAirportTripDuration",
    );
  }

  /**
   * Core route computation logic for airport trip duration
   */
  private async computeRoute(
    origin: GoogleRoutesOrigin,
    destinationAddress: string,
    methodName: string,
  ): Promise<DriveTimeResult> {
    try {
      const { data } = await this.httpClient.post<GoogleRoutesResponse>(this.baseUrl, {
        origin,
        destination: { address: destinationAddress },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: this.getNextDepartureTime(),
      });

      if (!data.routes || data.routes.length === 0) {
        this.logger.warn("No routes found", { destinationAddress });
        return { durationMinutes: FALLBACK_DURATION_MINUTES, distanceMeters: 0, isEstimate: true };
      }

      const route = data.routes[0];
      const durationSeconds = Number.parseInt(route.duration.replace("s", ""), 10);
      const durationMinutes = Math.ceil(durationSeconds / 60);

      this.logger.debug("Drive time calculated", {
        destinationAddress,
        durationMinutes,
        distanceMeters: route.distanceMeters,
      });

      return {
        durationMinutes,
        distanceMeters: route.distanceMeters,
        isEstimate: false,
      };
    } catch (error) {
      const errorInfo = this.httpClientService.handleError(error, methodName, "GoogleMaps");

      this.logger.error("Google Routes API error", {
        status: errorInfo.status,
        error: errorInfo.message,
        destinationAddress,
      });

      return { durationMinutes: FALLBACK_DURATION_MINUTES, distanceMeters: 0, isEstimate: true };
    }
  }

  /**
   * Get next departure time for traffic-aware routing
   * Uses current time + 1 hour to get realistic traffic estimates
   */
  private getNextDepartureTime(): string {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    return now.toISOString();
  }
}
