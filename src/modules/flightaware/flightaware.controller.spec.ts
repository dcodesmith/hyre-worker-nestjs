import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { FlightStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { FlightAwareController } from "./flightaware.controller";
import { FlightNonLagosDestinationException } from "./flightaware.error";
import { FlightAwareService } from "./flightaware.service";
import { FlightSearchThrottlerGuard } from "./flightaware-throttler.guard";
import { FLIGHT_SEARCH_THROTTLE_CONFIG } from "./flightaware-throttling.config";
import { FlightAwareWebhookService } from "./flightaware-webhook.service";
import { FlightAwareWebhookGuard } from "./guards/flightaware-webhook.guard";

describe("FlightAwareController", () => {
  let controller: FlightAwareController;
  let flightAwareService: FlightAwareService;
  let webhookService: FlightAwareWebhookService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: FLIGHT_SEARCH_THROTTLE_CONFIG.name,
            ttl: FLIGHT_SEARCH_THROTTLE_CONFIG.ttlMs,
            limit: FLIGHT_SEARCH_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      controllers: [FlightAwareController],
      providers: [
        {
          provide: FlightAwareService,
          useValue: {
            searchAirportPickupFlight: vi.fn(),
          },
        },
        {
          provide: FlightAwareWebhookService,
          useValue: {
            handleWebhook: vi.fn(),
          },
        },
        FlightSearchThrottlerGuard,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === "HMAC_KEY") return "hmac-key";
              return undefined;
            }),
            getOrThrow: vi.fn((key: string) => {
              if (key === "FLIGHTAWARE_WEBHOOK_SECRET") return "secret-123";
              if (key === "HMAC_KEY") return "hmac-key";
              throw new Error(`Missing key: ${key}`);
            }),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<FlightAwareController>(FlightAwareController);
    flightAwareService = module.get<FlightAwareService>(FlightAwareService);
    webhookService = module.get<FlightAwareWebhookService>(FlightAwareWebhookService);
  });

  it("returns successful search response for Lagos-bound flights", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockResolvedValueOnce({
      flight: {
        flightNumber: "BA74",
        flightId: "flight-1",
        origin: "EGLL",
        originIATA: "LHR",
        destination: "DNMM",
        destinationIATA: "LOS",
        scheduledDeparture: "2030-01-01T06:00:00.000Z",
        scheduledArrival: "2030-01-01T13:00:00.000Z",
        arrivalTime: "2030-01-01T13:00:00.000Z",
        arrivalTimeSource: "scheduled",
      },
    });

    const result = await controller.searchFlight({
      flightNumber: "BA74",
      date: "2030-01-01",
    });

    expect(result).toMatchObject({
      flight: {
        flightId: "flight-1",
      },
    });
  });

  it("propagates non-Lagos destination errors from the service", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockRejectedValueOnce(
      new FlightNonLagosDestinationException("BA74", "LHR", "JFK"),
    );

    await expect(
      controller.searchFlight({
        flightNumber: "BA74",
        date: "2030-01-01",
      }),
    ).rejects.toBeInstanceOf(FlightNonLagosDestinationException);
  });

  it("forwards webhook payload to webhook service", async () => {
    vi.mocked(webhookService.handleWebhook).mockResolvedValueOnce({
      duplicate: false,
      flightId: "flight-1",
      bookingCount: 2,
      newStatus: FlightStatus.LANDED,
    });

    const payload = {
      alert_id: 1,
      event_code: "arrival" as const,
      long_description: "BA74 has arrived.",
      short_description: "BA74 arrived",
      summary: "Arrival",
      flight: {
        ident: "BA74",
        fa_flight_id: "fa-1",
        origin: "EGLL",
        destination: "DNMM",
      },
    };

    const result = await controller.handleFlightAwareWebhook(payload, "flight-1");

    expect(webhookService.handleWebhook).toHaveBeenCalledWith(payload, "flight-1");
    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-1",
      bookingCount: 2,
      newStatus: FlightStatus.LANDED,
    });
  });

  it("applies FlightSearchThrottlerGuard on search-flight only", () => {
    const searchGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      FlightAwareController.prototype.searchFlight,
    );
    const webhookGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      FlightAwareController.prototype.handleFlightAwareWebhook,
    );

    expect(searchGuards).toContain(FlightSearchThrottlerGuard);
    expect(webhookGuards).toContain(FlightAwareWebhookGuard);
    expect(webhookGuards).not.toContain(FlightSearchThrottlerGuard);
  });
});
