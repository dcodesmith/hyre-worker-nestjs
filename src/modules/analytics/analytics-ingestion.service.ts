import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { z } from "zod";
import { toLogError } from "../../common/logging/error-logging.helper";
import { DatabaseService } from "../database/database.service";
import type {
  AnalyticsEventInsertData,
  AnalyticsEventWriter,
  AvailabilitySearchCompletedPayload,
  AvailabilitySearchFailedPayload,
  BookingRequestedInput,
  SearchEventInput,
} from "./analytics.interface";
import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsEventType,
  AnalyticsSource,
  availabilitySearchCompletedPayloadSchema,
  availabilitySearchFailedPayloadSchema,
  bookingRequestedPayloadSchema,
} from "./analytics-event.schema";

const optionalUuidSchema = z.uuid().optional();
const optionalRequestIdSchema = z.string().min(1).max(128).optional();

@Injectable()
export class AnalyticsIngestionService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalyticsIngestionService.name);
  }

  async recordAvailabilitySearchCompleted(
    input: SearchEventInput<AvailabilitySearchCompletedPayload>,
  ): Promise<void> {
    await this.recordSearchEventBestEffort(
      AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED,
      availabilitySearchCompletedPayloadSchema,
      input,
    );
  }

  async recordAvailabilitySearchFailed(
    input: SearchEventInput<AvailabilitySearchFailedPayload>,
  ): Promise<void> {
    await this.recordSearchEventBestEffort(
      AnalyticsEventType.AVAILABILITY_SEARCH_FAILED,
      availabilitySearchFailedPayloadSchema,
      input,
    );
  }

  async createBookingRequested(
    input: BookingRequestedInput,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const payload = bookingRequestedPayloadSchema.parse(input.payload);
    await this.insert(
      {
        eventKey: `${AnalyticsEventType.BOOKING_REQUESTED}:${input.bookingId}`,
        eventType: AnalyticsEventType.BOOKING_REQUESTED,
        source: AnalyticsSource.BOOKING_API,
        occurredAt: input.occurredAt,
        actorUserId: this.validUuid(input.actorUserId ?? undefined),
        searchId: this.validUuid(input.searchId ?? undefined),
        bookingId: input.bookingId,
        payload,
      },
      tx,
    );
  }

  private async recordSearchEventBestEffort(
    eventType:
      | typeof AnalyticsEventType.AVAILABILITY_SEARCH_COMPLETED
      | typeof AnalyticsEventType.AVAILABILITY_SEARCH_FAILED,
    schema:
      | typeof availabilitySearchCompletedPayloadSchema
      | typeof availabilitySearchFailedPayloadSchema,
    input: SearchEventInput<AvailabilitySearchCompletedPayload | AvailabilitySearchFailedPayload>,
  ): Promise<void> {
    try {
      const payload = schema.parse(input.payload);
      await this.insert({
        eventKey: `${eventType}:${input.context.searchId}:${payload.filterFingerprint}`,
        eventType,
        source: input.context.source,
        occurredAt: input.occurredAt,
        anonymousSessionId: this.validUuid(input.context.anonymousSessionId),
        requestId: optionalRequestIdSchema.safeParse(input.context.requestId).data,
        searchId: this.validUuid(input.context.searchId),
        payload,
      });
    } catch (error) {
      this.logger.error(
        {
          eventType,
          searchId: input.context.searchId,
          err: toLogError(error),
        },
        "Failed to record analytics event",
      );
    }
  }

  private validUuid(value: string | undefined): string | undefined {
    return optionalUuidSchema.safeParse(value).data;
  }

  private async insert(
    data: AnalyticsEventInsertData,
    writer: AnalyticsEventWriter = this.databaseService,
  ): Promise<void> {
    await writer.analyticsEvent.createMany({
      data: [
        {
          ...data,
          schemaVersion: ANALYTICS_SCHEMA_VERSION,
          payload: data.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
  }
}
