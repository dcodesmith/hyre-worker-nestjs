import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { MapsService } from "../src/modules/maps/maps.service";
import { TRIP_DURATION_THROTTLE_CONFIG } from "../src/modules/maps/maps-throttling.config";

describe("Maps E2E Tests", () => {
  let app: INestApplication;
  let mapsService: MapsService;

  beforeAll(async () => {
    const mockSendOtpEmail = vi.fn().mockResolvedValue(undefined);
    const mockMapsService = {
      calculateAirportTripDuration: vi.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOtpEmail })
      .overrideProvider(MapsService)
      .useValue(mockMapsService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    mapsService = moduleFixture.get(MapsService);

    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/calculate-trip-duration returns drive time", async () => {
    vi.mocked(mapsService.calculateAirportTripDuration).mockResolvedValueOnce({
      durationMinutes: 48,
      distanceMeters: 25000,
      isEstimate: false,
    });

    const response = await request(app.getHttpServer()).get(
      "/api/calculate-trip-duration?destination=Victoria%20Island%2C%20Lagos",
    );

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual({
      durationMinutes: 48,
      distanceMeters: 25000,
      isEstimate: false,
    });
  });

  it("GET /api/calculate-trip-duration returns 429 after exceeding the IP rate limit", async () => {
    vi.mocked(mapsService.calculateAirportTripDuration).mockResolvedValue({
      durationMinutes: 48,
      distanceMeters: 25000,
      isEstimate: false,
    });

    let response: request.Response | undefined;
    const maxAttempts = TRIP_DURATION_THROTTLE_CONFIG.limit + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      response = await request(app.getHttpServer())
        .get("/api/calculate-trip-duration?destination=Victoria%20Island%2C%20Lagos")
        .set("x-forwarded-for", "198.51.100.21");

      if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
        break;
      }
    }

    expect(response?.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(response?.body.detail).toBe(
      "Too many trip duration requests. Please try again shortly.",
    );
    expect(response?.headers["retry-after"]).toBeDefined();
    expect(response?.headers["ratelimit-limit"]).toBe(String(TRIP_DURATION_THROTTLE_CONFIG.limit));
    expect(response?.headers["ratelimit-remaining"]).toBe("0");
    expect(response?.headers["ratelimit-policy"]).toBe(
      `${TRIP_DURATION_THROTTLE_CONFIG.limit};w=${TRIP_DURATION_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });

  it("GET /api/calculate-trip-duration does not block a different IP after one IP is limited", async () => {
    vi.mocked(mapsService.calculateAirportTripDuration).mockResolvedValue({
      durationMinutes: 48,
      distanceMeters: 25000,
      isEstimate: false,
    });

    const exhaustedIp = "198.51.100.42";
    const otherIp = "198.51.100.43";
    const path = "/api/calculate-trip-duration?destination=Victoria%20Island%2C%20Lagos";

    for (let attempt = 0; attempt < TRIP_DURATION_THROTTLE_CONFIG.limit + 1; attempt += 1) {
      await request(app.getHttpServer()).get(path).set("x-forwarded-for", exhaustedIp);
    }

    const blocked = await request(app.getHttpServer())
      .get(path)
      .set("x-forwarded-for", exhaustedIp);
    const allowed = await request(app.getHttpServer()).get(path).set("x-forwarded-for", otherIp);

    expect(blocked.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(allowed.status).toBe(HttpStatus.OK);
  });
});
