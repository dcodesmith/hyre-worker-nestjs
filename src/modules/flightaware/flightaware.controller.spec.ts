import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { FlightStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlightAwareController } from "./flightaware.controller";
import { FlightAwareService } from "./flightaware.service";
import { FlightAwareWebhookService } from "./flightaware-webhook.service";

describe("FlightAwareController", () => {
  let controller: FlightAwareController;
  let flightAwareService: FlightAwareService;
  let webhookService: FlightAwareWebhookService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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
    }).compile();

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
        scheduledArrival: "2030-01-01T13:00:00.000Z",
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

  it("returns informational response for non-Lagos flights", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockResolvedValueOnce({
      message:
        "Flight BA74 flies from LHR to JFK. We only provide airport pickup for flights arriving in Lagos (LOS).",
      flight: null,
    });

    const result = await controller.searchFlight({
      flightNumber: "BA74",
      date: "2030-01-01",
    });

    expect(result).toEqual({
      message:
        "Flight BA74 flies from LHR to JFK. We only provide airport pickup for flights arriving in Lagos (LOS).",
      flight: null,
    });
  });

  it("forwards webhook payload to webhook service", async () => {
    vi.mocked(webhookService.handleWebhook).mockResolvedValueOnce({
      duplicate: false,
      flightId: "flight-1",
      bookingCount: 2,
      newStatus: FlightStatus.LANDED,
    });

    const payload = {
      alert_id: "alert-1",
      event_type: "arrival",
      event_time: "2030-01-01T12:00:00.000Z",
      flight: {
        ident: "BA74",
        fa_flight_id: "fa-1",
        origin: { code: "EGLL" },
        destination: { code: "DNMM" },
      },
    };

    const result = await controller.handleFlightAwareWebhook(payload);

    expect(webhookService.handleWebhook).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      duplicate: false,
      flightId: "flight-1",
      bookingCount: 2,
      newStatus: FlightStatus.LANDED,
    });
  });
});
