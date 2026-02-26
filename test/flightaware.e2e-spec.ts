import { HttpStatus, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { FlightStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlightAwareService } from "../src/modules/flightaware/flightaware.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("FlightAware E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let flightAwareService: FlightAwareService;
  let webhookPath: string;

  const upcomingDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const mockSendOtpEmail = vi.fn().mockResolvedValue(undefined);
    const mockFlightAwareService = {
      searchAirportPickupFlight: vi.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOtpEmail })
      .overrideProvider(FlightAwareService)
      .useValue(mockFlightAwareService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    flightAwareService = moduleFixture.get(FlightAwareService);
    const configService = app.get(ConfigService);
    const configuredWebhookSecret = configService.getOrThrow("FLIGHTAWARE_WEBHOOK_SECRET");
    webhookPath = `/api/webhooks/flightaware?secret=${configuredWebhookSecret}`;

    await app.init();
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/search-flight returns info for non-Lagos destination", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockResolvedValueOnce({
      message:
        "Flight BA74 flies from LHR to JFK. We only provide airport pickup for flights arriving in Lagos (LOS).",
      flight: null,
    });

    const response = await request(app.getHttpServer()).get(
      `/api/search-flight?flightNumber=BA74&date=${upcomingDate}`,
    );

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual({
      message:
        "Flight BA74 flies from LHR to JFK. We only provide airport pickup for flights arriving in Lagos (LOS).",
      flight: null,
    });
  });

  it("POST /api/webhooks/flightaware rejects invalid secret", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/webhooks/flightaware?secret=wrong-secret")
      .send({
        alert_id: "alert-1",
        event_type: "arrival",
        event_time: "2030-01-01T10:00:00.000Z",
        flight: {
          ident: "BA74",
          fa_flight_id: "fa-1",
          origin: { code: "EGLL" },
          destination: { code: "DNMM" },
        },
      });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/webhooks/flightaware processes event for known alert", async () => {
    const user = await factory.createUser({ email: uniqueEmail("flight-webhook-user") });
    const owner = await factory.createFleetOwner();
    const car = await factory.createCar(owner.id);

    const flight = await databaseService.flight.create({
      data: {
        flightNumber: "BA74",
        flightDate: new Date("2030-01-01"),
        faFlightId: "fa-1",
        originCode: "EGLL",
        originCodeIATA: "LHR",
        destinationCode: "DNMM",
        destinationCodeIATA: "LOS",
        scheduledArrival: new Date("2030-01-01T10:30:00.000Z"),
        status: FlightStatus.SCHEDULED,
        alertId: "alert-known",
        alertEnabled: true,
      },
    });

    const booking = await factory.createBooking(user.id, car.id, {
      startDate: new Date("2030-01-01T08:00:00.000Z"),
      endDate: new Date("2030-01-01T13:00:00.000Z"),
    });

    await databaseService.booking.update({
      where: { id: booking.id },
      data: { flightId: flight.id },
    });

    const response = await request(app.getHttpServer())
      .post(webhookPath)
      .send({
        alert_id: "alert-known",
        event_type: "arrival",
        event_time: "2030-01-01T10:45:00.000Z",
        flight: {
          ident: "BA74",
          fa_flight_id: "fa-1",
          estimated_in: "2030-01-01T10:40:00.000Z",
          actual_in: "2030-01-01T10:44:00.000Z",
          origin: { code: "EGLL", code_iata: "LHR" },
          destination: { code: "DNMM", code_iata: "LOS" },
        },
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toMatchObject({
      duplicate: false,
      flightId: flight.id,
      bookingCount: 1,
      newStatus: "LANDED",
    });

    const storedFlight = await databaseService.flight.findUnique({ where: { id: flight.id } });
    expect(storedFlight?.status).toBe("LANDED");

    const storedEvent = await databaseService.flightStatusEvent.findFirst({
      where: { flightId: flight.id, eventType: "arrival" },
    });
    expect(storedEvent?.processed).toBe(true);
  });
});
