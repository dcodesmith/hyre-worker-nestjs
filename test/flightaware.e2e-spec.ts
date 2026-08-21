import { getQueueToken } from "@nestjs/bullmq";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, BookingType, FlightStatus, PaymentStatus } from "@prisma/client";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { createHmacSignature } from "../src/common/security/webhook-signature.helper";
import { NOTIFICATIONS_QUEUE } from "../src/config/constants";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlightAwareService } from "../src/modules/flightaware/flightaware.service";
import { FlightAwareCacheService } from "../src/modules/flightaware/flightaware-cache.service";
import { FLIGHT_SEARCH_THROTTLE_CONFIG } from "../src/modules/flightaware/flightaware-throttling.config";
import { NotificationOutboxService } from "../src/modules/notification/notification-outbox.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("FlightAware E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let flightAwareService: FlightAwareService;
  let flightAwareCacheService: FlightAwareCacheService;
  let notificationOutboxService: NotificationOutboxService;
  let notificationsQueue: Queue;
  let webhookSecret: string;

  const upcomingDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const buildWebhookPath = (flightId: string) =>
    `/api/webhooks/flightaware?flightId=${encodeURIComponent(flightId)}&signature=${createHmacSignature(flightId, webhookSecret)}`;

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
    flightAwareCacheService = moduleFixture.get(FlightAwareCacheService);
    notificationOutboxService = moduleFixture.get(NotificationOutboxService);
    notificationsQueue = moduleFixture.get(getQueueToken(NOTIFICATIONS_QUEUE));
    const configService = app.get(ConfigService);
    webhookSecret = configService.getOrThrow("FLIGHTAWARE_WEBHOOK_SECRET");

    await app.init();
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/search-flight returns the authoritative delayed arrival without client caching", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockResolvedValueOnce({
      flight: {
        flightNumber: "DL54",
        flightId: "DAL54-20260720",
        origin: "KATL",
        originIATA: "ATL",
        destination: "DNMM",
        destinationIATA: "LOS",
        scheduledArrival: "2026-07-20T08:45:00.000Z",
        estimatedArrival: "2026-07-20T09:11:00.000Z",
        arrivalTime: "2026-07-20T09:11:00.000Z",
        arrivalTimeSource: "estimated",
        status: "On The Way! / Delayed",
        isLive: true,
      },
    });

    const response = await request(app.getHttpServer()).get(
      `/api/search-flight?flightNumber=DL54&date=${upcomingDate}`,
    );

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      flight: {
        flightNumber: "DL54",
        scheduledArrival: "2026-07-20T08:45:00.000Z",
        estimatedArrival: "2026-07-20T09:11:00.000Z",
        arrivalTime: "2026-07-20T09:11:00.000Z",
        arrivalTimeSource: "estimated",
      },
    });
    expect(flightAwareService.searchAirportPickupFlight).toHaveBeenCalledWith("DL54", upcomingDate);
  });

  it("GET /api/search-flight returns 429 after exceeding the IP rate limit", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockResolvedValue({
      flight: {
        flightNumber: "DL54",
        flightId: "DAL54-rate-limit",
        origin: "KATL",
        originIATA: "ATL",
        destination: "DNMM",
        destinationIATA: "LOS",
        scheduledArrival: "2026-07-20T08:45:00.000Z",
        arrivalTime: "2026-07-20T08:45:00.000Z",
        arrivalTimeSource: "scheduled",
        status: "Scheduled",
        isLive: false,
      },
    });

    let response: request.Response | undefined;
    const maxAttempts = FLIGHT_SEARCH_THROTTLE_CONFIG.limit + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      response = await request(app.getHttpServer())
        .get(`/api/search-flight?flightNumber=DL54&date=${upcomingDate}`)
        .set("x-forwarded-for", "198.51.100.20");

      if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
        break;
      }
    }

    expect(response?.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(response?.body.detail).toBe(
      "Too many flight search requests. Please try again shortly.",
    );
    expect(response?.headers["retry-after"]).toBeDefined();
    expect(response?.headers["ratelimit-limit"]).toBe(String(FLIGHT_SEARCH_THROTTLE_CONFIG.limit));
    expect(response?.headers["ratelimit-remaining"]).toBe("0");
    expect(response?.headers["ratelimit-policy"]).toBe(
      `${FLIGHT_SEARCH_THROTTLE_CONFIG.limit};w=${FLIGHT_SEARCH_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });

  it("GET /api/search-flight does not block a different IP after one IP is limited", async () => {
    vi.mocked(flightAwareService.searchAirportPickupFlight).mockResolvedValue({
      flight: {
        flightNumber: "DL54",
        flightId: "DAL54-rate-limit-other-ip",
        origin: "KATL",
        originIATA: "ATL",
        destination: "DNMM",
        destinationIATA: "LOS",
        scheduledArrival: "2026-07-20T08:45:00.000Z",
        arrivalTime: "2026-07-20T08:45:00.000Z",
        arrivalTimeSource: "scheduled",
        status: "Scheduled",
        isLive: false,
      },
    });

    const exhaustedIp = "198.51.100.40";
    const otherIp = "198.51.100.41";
    const path = `/api/search-flight?flightNumber=DL54&date=${upcomingDate}`;

    for (let attempt = 0; attempt < FLIGHT_SEARCH_THROTTLE_CONFIG.limit + 1; attempt += 1) {
      await request(app.getHttpServer()).get(path).set("x-forwarded-for", exhaustedIp);
    }

    const blocked = await request(app.getHttpServer())
      .get(path)
      .set("x-forwarded-for", exhaustedIp);
    const allowed = await request(app.getHttpServer()).get(path).set("x-forwarded-for", otherIp);

    expect(blocked.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(allowed.status).toBe(HttpStatus.OK);
  });

  it("shares flight search results through Redis", async () => {
    const flight = {
      flightNumber: "DL54",
      flightId: "DAL54-redis-e2e",
      origin: "KATL",
      destination: "DNMM",
      scheduledArrival: "2030-01-01T08:45:00.000Z",
      estimatedArrival: "2030-01-01T09:11:00.000Z",
      arrivalTime: "2030-01-01T09:11:00.000Z",
      arrivalTimeSource: "estimated" as const,
      isLive: true,
    };

    await flightAwareCacheService.set("DL54", "2030-01-01", flight);

    await expect(flightAwareCacheService.get("dl54", "2030-01-01")).resolves.toEqual(flight);
  });

  it("POST /api/webhooks/flightaware rejects an invalid signature", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/webhooks/flightaware?flightId=flight-1&signature=wrong-signature")
      .send({
        alert_id: 1,
        event_code: "arrival",
        long_description: "BA74 has arrived.",
        short_description: "BA74 arrived",
        summary: "Arrival",
        flight: {
          ident: "BA74",
          fa_flight_id: "fa-1",
          origin: "EGLL",
          destination: "DNMM",
        },
      });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/webhooks/flightaware alerts the owner and assigned chauffeur for arrival", async () => {
    const user = await factory.createUser({ email: uniqueEmail("flight-webhook-user") });
    const owner = await factory.createFleetOwner({ phoneNumber: "+2348011111111" });
    const chauffeur = await factory.createChauffeur({ phoneNumber: "+2348022222222" });
    await databaseService.user.update({
      where: { id: owner.id },
      data: { phoneNumber: "+2348011111111" },
    });
    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: { phoneNumber: "+2348022222222" },
    });
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
        alertId: "98765",
        alertEnabled: true,
      },
    });

    const booking = await factory.createBooking(user.id, car.id, {
      startDate: new Date("2030-01-01T08:00:00.000Z"),
      endDate: new Date("2030-01-01T13:00:00.000Z"),
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      chauffeurId: chauffeur.id,
    });

    await databaseService.booking.update({
      where: { id: booking.id },
      data: { flightId: flight.id, type: BookingType.AIRPORT_PICKUP },
    });

    const payload = {
      alert_id: 98765,
      event_code: "arrival",
      long_description: "BA74 has arrived.",
      short_description: "BA74 arrived",
      summary: "Arrival",
      flight: {
        ident: "BA74",
        fa_flight_id: "fa-1",
        estimated_in: "2030-01-01T10:40:00.000Z",
        actual_in: "2030-01-01T10:44:00.000Z",
        arrival_delay: 840,
        gate_destination: "G2",
        origin: "EGLL",
        origin_iata: "LHR",
        destination: "DNMM",
        destination_iata: "LOS",
      },
    };
    const mismatchedResponse = await request(app.getHttpServer())
      .post(buildWebhookPath("another-flight"))
      .send(payload);
    expect(mismatchedResponse.status).toBe(HttpStatus.NOT_FOUND);

    const webhookPath = buildWebhookPath(flight.id);
    const response = await request(app.getHttpServer()).post(webhookPath).send(payload);

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

    const ownerOutboxRow = await databaseService.notificationOutboxEvent.findUnique({
      where: {
        dedupeKey: `flight-update:${storedEvent?.id}:flight-arrived:${booking.id}:fleetOwner`,
      },
    });
    expect(ownerOutboxRow).toMatchObject({
      bookingId: booking.id,
      userId: owner.id,
      eventType: "BOOKING_LIFECYCLE",
    });
    expect(ownerOutboxRow?.payload).toMatchObject({
      subtype: "flight-arrived",
    });

    const chauffeurOutboxRow = await databaseService.notificationOutboxEvent.findUnique({
      where: {
        dedupeKey: `flight-update:${storedEvent?.id}:flight-arrived:${booking.id}:chauffeur`,
      },
    });
    expect(chauffeurOutboxRow).toMatchObject({
      bookingId: booking.id,
      userId: chauffeur.id,
      eventType: "BOOKING_LIFECYCLE",
    });
    await expect(
      databaseService.notificationInbox.count({
        where: { userId: user.id, type: "BOOKING_LIFECYCLE" },
      }),
    ).resolves.toBe(0);

    await notificationOutboxService.processPendingEvents();
    const ownerNotificationJob = await notificationsQueue.getJob(
      `notification-outbox-${ownerOutboxRow?.id}`,
    );
    expect(ownerNotificationJob?.data).toMatchObject({
      id: `flight-arrived-${storedEvent?.id}-${booking.id}-fleet-owner-${owner.id}`,
      type: "flight-arrived",
      audience: "fleet-owner",
      channels: ["email"],
      bookingId: booking.id,
      recipients: {
        fleetOwner: {
          userId: owner.id,
          email: owner.email,
        },
      },
      templateData: {
        templateKind: "flightUpdate",
        flightNumber: "BA74",
        bookingReference: booking.bookingReference,
        updateTitle: "Pickup flight arrived",
      },
    });
    const chauffeurNotificationJob = await notificationsQueue.getJob(
      `notification-outbox-${chauffeurOutboxRow?.id}`,
    );
    expect(chauffeurNotificationJob?.data).toMatchObject({
      audience: "chauffeur",
      recipients: {
        chauffeur: {
          userId: chauffeur.id,
          email: chauffeur.email,
        },
      },
    });

    const duplicateResponse = await request(app.getHttpServer()).post(webhookPath).send(payload);
    expect(duplicateResponse.status).toBe(HttpStatus.OK);
    expect(duplicateResponse.body.duplicate).toBe(true);
    await expect(
      databaseService.flightStatusEvent.count({
        where: { flightId: flight.id, eventType: "arrival" },
      }),
    ).resolves.toBe(1);
    await expect(
      databaseService.notificationOutboxEvent.count({
        where: {
          bookingId: booking.id,
        },
      }),
    ).resolves.toBe(2);
  }, 60_000);
});
