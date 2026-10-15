import { Test, type TestingModule } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import { BookingType, ServiceTier, VehicleType } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import type {
  AvailabilitySearchCompletedPayload,
  AvailabilitySearchFailedPayload,
  BookingRequestedPayload,
} from "./analytics.interface";
import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsChannel,
  AnalyticsEventType,
} from "./analytics-event.schema";
import { AnalyticsIngestionService } from "./analytics-ingestion.service";

const SEARCH_ID = "01994a1d-4263-7000-8000-000000000001";
const OTHER_SEARCH_ID = "01994a1d-4263-7000-8000-000000000002";
const SESSION_ID = "01994a1d-4263-7000-8000-000000000003";
const ACTOR_ID = "01994a1d-4263-7000-8000-000000000004";
const CAR_ID = "01994a1d-4263-7000-8000-000000000005";
const BOOKING_ID = "01994a1d-4263-7000-8000-000000000006";
const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);
const OCCURRED_AT = new Date("2026-03-01T12:00:00.000Z");

const market = {
  countryCode: "NG",
  marketCode: "LAGOS",
  timezone: "Africa/Lagos",
} as const;

const filters = {
  bookingType: BookingType.DAY,
  vehicleTypes: [VehicleType.SUV],
  serviceTiers: [ServiceTier.EXECUTIVE],
  from: "2026-03-01T07:00:00.000Z",
  to: "2026-03-02T19:00:00.000Z",
  pickupTime: null,
  minPrice: null,
  maxPrice: null,
  minCapacity: null,
  fuelIncluded: null,
  dealsOnly: null,
};

function completedPayload(
  overrides: Partial<AvailabilitySearchCompletedPayload> = {},
): AvailabilitySearchCompletedPayload {
  return {
    filters,
    filterFingerprint: FINGERPRINT,
    resultCount: 2,
    filterMatchCount: null,
    outcome: "MATCHES_FOUND",
    market,
    ...overrides,
  };
}

function failedPayload(
  overrides: Partial<AvailabilitySearchFailedPayload> = {},
): AvailabilitySearchFailedPayload {
  return {
    filters,
    filterFingerprint: FINGERPRINT,
    errorCode: "SEARCH_EXECUTION_FAILED",
    market,
    ...overrides,
  };
}

function bookingPayload(overrides: Partial<BookingRequestedPayload> = {}): BookingRequestedPayload {
  return {
    bookingType: BookingType.DAY,
    startDate: "2026-03-01T09:00:00.000Z",
    endDate: "2026-03-01T21:00:00.000Z",
    carId: CAR_ID,
    vehicleType: VehicleType.SEDAN,
    serviceTier: ServiceTier.STANDARD,
    amount: "56437.50",
    currency: "NGN",
    market,
    ...overrides,
  };
}

describe("AnalyticsIngestionService", () => {
  let service: AnalyticsIngestionService;
  let logger: { error: ReturnType<typeof vi.fn> };
  const createMany = vi.fn().mockResolvedValue({ count: 1 });

  beforeEach(async () => {
    vi.clearAllMocks();
    createMany.mockResolvedValue({ count: 1 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsIngestionService,
        { provide: DatabaseService, useValue: { analyticsEvent: { createMany } } },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(AnalyticsIngestionService);
    logger = module.get(PinoLogger);
  });

  function insertedRow(callIndex = 0) {
    return createMany.mock.calls[callIndex][0].data[0];
  }

  it("inserts a validated completed search with a fingerprint event key", async () => {
    const requestId = "r".repeat(128);
    await service.recordAvailabilitySearchCompleted({
      context: {
        channel: AnalyticsChannel.WEB,
        searchId: SEARCH_ID,
        anonymousSessionId: SESSION_ID,
        requestId,
      },
      occurredAt: OCCURRED_AT,
      payload: completedPayload(),
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          eventKey: `${AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED}:${SEARCH_ID}:${FINGERPRINT}`,
          eventType: AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED,
          source: AnalyticsChannel.WEB,
          occurredAt: OCCURRED_AT,
          anonymousSessionId: SESSION_ID,
          requestId,
          searchId: SEARCH_ID,
          payload: completedPayload(),
          schemaVersion: ANALYTICS_SCHEMA_VERSION,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("reuses the event key for the same search and fingerprint and changes it when the fingerprint changes", async () => {
    const input = {
      context: { channel: AnalyticsChannel.WHATSAPP, searchId: SEARCH_ID },
      occurredAt: OCCURRED_AT,
      payload: completedPayload(),
    };

    await service.recordAvailabilitySearchCompleted(input);
    await service.recordAvailabilitySearchCompleted(input);
    await service.recordAvailabilitySearchCompleted({
      ...input,
      payload: completedPayload({ filterFingerprint: OTHER_FINGERPRINT }),
    });

    expect(insertedRow(0).source).toBe(AnalyticsChannel.WHATSAPP);
    expect(insertedRow(0).eventKey).toBe(
      `${AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED}:${SEARCH_ID}:${FINGERPRINT}`,
    );
    expect(insertedRow(1).eventKey).toBe(insertedRow(0).eventKey);
    expect(insertedRow(2).eventKey).toBe(
      `${AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED}:${SEARCH_ID}:${OTHER_FINGERPRINT}`,
    );
    expect(createMany.mock.calls.every((call) => call[0].skipDuplicates === true)).toBe(true);
  });

  it("inserts a validated failed search", async () => {
    await service.recordAvailabilitySearchFailed({
      context: { channel: AnalyticsChannel.WEB, searchId: OTHER_SEARCH_ID },
      occurredAt: OCCURRED_AT,
      payload: failedPayload(),
    });

    expect(insertedRow()).toMatchObject({
      eventKey: `${AnalyticsEventType.AVAILABILITY_SEARCH_FAILED}:${OTHER_SEARCH_ID}:${FINGERPRINT}`,
      eventType: AnalyticsEventType.AVAILABILITY_SEARCH_FAILED,
      source: AnalyticsChannel.WEB,
      searchId: OTHER_SEARCH_ID,
      payload: failedPayload(),
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
    });
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it("omits invalid optional session, request, and search ids", async () => {
    await service.recordAvailabilitySearchCompleted({
      context: {
        channel: AnalyticsChannel.WEB,
        searchId: "not-a-uuid",
        anonymousSessionId: "not-a-uuid",
        requestId: "",
      },
      occurredAt: OCCURRED_AT,
      payload: completedPayload(),
    });
    await service.recordAvailabilitySearchCompleted({
      context: {
        channel: AnalyticsChannel.WEB,
        searchId: SEARCH_ID,
        anonymousSessionId: SESSION_ID,
        requestId: "r".repeat(129),
      },
      occurredAt: OCCURRED_AT,
      payload: completedPayload(),
    });

    expect(insertedRow(0).searchId).toBeUndefined();
    expect(insertedRow(0).anonymousSessionId).toBeUndefined();
    expect(insertedRow(0).requestId).toBeUndefined();
    expect(insertedRow(1).searchId).toBe(SEARCH_ID);
    expect(insertedRow(1).anonymousSessionId).toBe(SESSION_ID);
    expect(insertedRow(1).requestId).toBeUndefined();
  });

  it("logs and swallows search schema and insert failures", async () => {
    await expect(
      service.recordAvailabilitySearchCompleted({
        context: { channel: AnalyticsChannel.WEB, searchId: SEARCH_ID },
        occurredAt: OCCURRED_AT,
        payload: completedPayload({ resultCount: -1 }),
      }),
    ).resolves.toBeUndefined();
    expect(createMany).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      {
        eventType: AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED,
        searchId: SEARCH_ID,
        err: expect.any(Error),
      },
      "Failed to record analytics event",
    );

    logger.error.mockClear();
    createMany.mockRejectedValueOnce(new Error("insert failed"));
    await expect(
      service.recordAvailabilitySearchFailed({
        context: { channel: AnalyticsChannel.WHATSAPP, searchId: SEARCH_ID },
        occurredAt: OCCURRED_AT,
        payload: failedPayload(),
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      {
        eventType: AnalyticsEventType.AVAILABILITY_SEARCH_FAILED,
        searchId: SEARCH_ID,
        err: expect.any(Error),
      },
      "Failed to record analytics event",
    );
  });

  it("inserts BOOKING_REQUESTED through the transaction client with a deterministic key", async () => {
    const tx = {
      analyticsEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await service.createBookingRequested(
      {
        actorUserId: ACTOR_ID,
        bookingId: BOOKING_ID,
        channel: AnalyticsChannel.WEB,
        occurredAt: OCCURRED_AT,
        searchId: SEARCH_ID,
        payload: bookingPayload(),
      },
      tx as unknown as Prisma.TransactionClient,
    );

    expect(createMany).not.toHaveBeenCalled();
    expect(tx.analyticsEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          eventKey: `${AnalyticsEventType.BOOKING_REQUESTED}:${BOOKING_ID}`,
          eventType: AnalyticsEventType.BOOKING_REQUESTED,
          source: AnalyticsChannel.WEB,
          occurredAt: OCCURRED_AT,
          actorUserId: ACTOR_ID,
          searchId: SEARCH_ID,
          bookingId: BOOKING_ID,
          payload: bookingPayload(),
          schemaVersion: ANALYTICS_SCHEMA_VERSION,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("omits null or invalid booking actor and search ids", async () => {
    const tx = {
      analyticsEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const client = tx as unknown as Prisma.TransactionClient;

    await service.createBookingRequested(
      {
        actorUserId: null,
        bookingId: BOOKING_ID,
        channel: AnalyticsChannel.WHATSAPP,
        occurredAt: OCCURRED_AT,
        searchId: null,
        payload: bookingPayload(),
      },
      client,
    );
    await service.createBookingRequested(
      {
        actorUserId: "not-a-uuid",
        bookingId: BOOKING_ID,
        channel: AnalyticsChannel.WHATSAPP,
        occurredAt: OCCURRED_AT,
        searchId: "not-a-uuid",
        payload: bookingPayload(),
      },
      client,
    );

    expect(tx.analyticsEvent.createMany.mock.calls[0][0].data[0].source).toBe(
      AnalyticsChannel.WHATSAPP,
    );
    expect(tx.analyticsEvent.createMany.mock.calls[0][0].data[0].actorUserId).toBeUndefined();
    expect(tx.analyticsEvent.createMany.mock.calls[0][0].data[0].searchId).toBeUndefined();
    expect(tx.analyticsEvent.createMany.mock.calls[1][0].data[0].actorUserId).toBeUndefined();
    expect(tx.analyticsEvent.createMany.mock.calls[1][0].data[0].searchId).toBeUndefined();
    expect(tx.analyticsEvent.createMany.mock.calls[0][0].data[0].eventKey).toBe(
      tx.analyticsEvent.createMany.mock.calls[1][0].data[0].eventKey,
    );
  });

  it("propagates booking validation and insert failures", async () => {
    const tx = {
      analyticsEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const client = tx as unknown as Prisma.TransactionClient;
    const invalidPayload = { ...bookingPayload(), currency: "USD" };

    await expect(
      service.createBookingRequested(
        {
          actorUserId: ACTOR_ID,
          bookingId: BOOKING_ID,
          channel: AnalyticsChannel.WEB,
          occurredAt: OCCURRED_AT,
          searchId: SEARCH_ID,
          payload: invalidPayload as BookingRequestedPayload,
        },
        client,
      ),
    ).rejects.toThrow();
    expect(tx.analyticsEvent.createMany).not.toHaveBeenCalled();

    const insertError = new Error("analytics insert failed");
    tx.analyticsEvent.createMany.mockRejectedValueOnce(insertError);
    await expect(
      service.createBookingRequested(
        {
          actorUserId: ACTOR_ID,
          bookingId: BOOKING_ID,
          channel: AnalyticsChannel.WEB,
          occurredAt: OCCURRED_AT,
          searchId: SEARCH_ID,
          payload: bookingPayload(),
        },
        client,
      ),
    ).rejects.toBe(insertError);
  });
});
