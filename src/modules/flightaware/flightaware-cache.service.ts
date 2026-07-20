import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type Redis from "ioredis";
import { PinoLogger } from "nestjs-pino";
import type { ValidatedFlight } from "./flightaware.interface";

export const FLIGHTAWARE_REDIS_CLIENT = Symbol("FLIGHTAWARE_REDIS_CLIENT");
export type FlightAwareRedisClient = Redis;

const CACHE_KEY_PREFIX = "flightaware:search:v1";
const LIVE_FLIGHT_TTL_SECONDS = 60;
const SCHEDULED_FLIGHT_TTL_SECONDS = 24 * 60 * 60;
const NOT_FOUND_TTL_SECONDS = 5 * 60;

type FlightCacheEntry = {
  data: ValidatedFlight | null;
};

@Injectable()
export class FlightAwareCacheService implements OnModuleDestroy {
  constructor(
    @Inject(FLIGHTAWARE_REDIS_CLIENT) private readonly redis: FlightAwareRedisClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FlightAwareCacheService.name);
  }

  async get(flightNumber: string, pickupDate: string): Promise<ValidatedFlight | null | undefined> {
    const key = this.getCacheKey(flightNumber, pickupDate);

    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        return undefined;
      }

      const entry = JSON.parse(raw) as FlightCacheEntry;
      if (!entry || typeof entry !== "object" || !("data" in entry)) {
        throw new Error("Invalid flight cache entry");
      }

      return entry.data;
    } catch (error) {
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        "Failed to read FlightAware cache; falling back to API",
      );
      return undefined;
    }
  }

  async set(flightNumber: string, pickupDate: string, data: ValidatedFlight | null): Promise<void> {
    const key = this.getCacheKey(flightNumber, pickupDate);
    const ttlSeconds =
      data === null
        ? NOT_FOUND_TTL_SECONDS
        : data.isLive
          ? LIVE_FLIGHT_TTL_SECONDS
          : SCHEDULED_FLIGHT_TTL_SECONDS;

    try {
      await this.redis.setex(key, ttlSeconds, JSON.stringify({ data } satisfies FlightCacheEntry));
    } catch (error) {
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        "Failed to write FlightAware cache",
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to quit FLIGHTAWARE_REDIS_CLIENT, forcing disconnect",
      );
      this.redis.disconnect();
    }
  }

  private getCacheKey(flightNumber: string, pickupDate: string): string {
    return `${CACHE_KEY_PREFIX}:${flightNumber.toUpperCase()}:${pickupDate}`;
  }
}
