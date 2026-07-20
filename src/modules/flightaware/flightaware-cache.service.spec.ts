import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import type { ValidatedFlight } from "./flightaware.interface";
import {
  FLIGHTAWARE_REDIS_CLIENT,
  FlightAwareCacheService,
  type FlightAwareRedisClient,
} from "./flightaware-cache.service";

describe("FlightAwareCacheService", () => {
  let service: FlightAwareCacheService;
  let redis: {
    get: ReturnType<typeof vi.fn>;
    setex: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };

  const liveFlight: ValidatedFlight = {
    flightNumber: "DL54",
    flightId: "DAL54-20260720",
    origin: "KATL",
    destination: "DNMM",
    scheduledArrival: "2026-07-20T08:45:00Z",
    estimatedArrival: "2026-07-20T09:11:00Z",
    arrivalTime: "2026-07-20T09:11:00Z",
    arrivalTimeSource: "estimated",
    isLive: true,
  };

  beforeEach(async () => {
    redis = {
      get: vi.fn(),
      setex: vi.fn().mockResolvedValue("OK"),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareCacheService,
        {
          provide: FLIGHTAWARE_REDIS_CLIENT,
          useValue: redis as unknown as FlightAwareRedisClient,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(FlightAwareCacheService);
  });

  it("returns undefined on a cache miss", async () => {
    redis.get.mockResolvedValue(null);

    await expect(service.get("DL54", "2026-07-20")).resolves.toBeUndefined();
    expect(redis.get).toHaveBeenCalledWith("flightaware:search:v1:DL54:2026-07-20");
  });

  it("returns cached flights and cached not-found results", async () => {
    redis.get
      .mockResolvedValueOnce(JSON.stringify({ data: liveFlight }))
      .mockResolvedValueOnce(JSON.stringify({ data: null }));

    await expect(service.get("dl54", "2026-07-20")).resolves.toEqual(liveFlight);
    await expect(service.get("DL54", "2026-07-20")).resolves.toBeNull();
  });

  it.each([
    ["live flights", liveFlight, 60],
    ["scheduled flights", { ...liveFlight, isLive: false }, 86_400],
    ["not-found results", null, 300],
  ])("stores %s with the correct TTL", async (_name, data, ttlSeconds) => {
    await service.set("DL54", "2026-07-20", data);

    expect(redis.setex).toHaveBeenCalledWith(
      "flightaware:search:v1:DL54:2026-07-20",
      ttlSeconds,
      JSON.stringify({ data }),
    );
  });

  it("fails open when Redis reads or writes fail", async () => {
    redis.get.mockRejectedValueOnce(new Error("Redis unavailable"));
    redis.setex.mockRejectedValueOnce(new Error("Redis unavailable"));

    await expect(service.get("DL54", "2026-07-20")).resolves.toBeUndefined();
    await expect(service.set("DL54", "2026-07-20", liveFlight)).resolves.toBeUndefined();
  });

  it("forces disconnect when graceful Redis shutdown fails", async () => {
    redis.quit.mockRejectedValueOnce(new Error("Connection closed"));

    await service.onModuleDestroy();

    expect(redis.disconnect).toHaveBeenCalledOnce();
  });
});
