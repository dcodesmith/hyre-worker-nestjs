import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { MapsService } from "../src/modules/maps/maps.service";

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
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
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

  it("GET /api/calculate-trip-duration returns 400 when destination is missing", async () => {
    const response = await request(app.getHttpServer()).get("/api/calculate-trip-duration");

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(vi.mocked(mapsService.calculateAirportTripDuration)).not.toHaveBeenCalled();
  });
});
