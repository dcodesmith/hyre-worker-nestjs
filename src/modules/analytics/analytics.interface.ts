import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import type {
  AnalyticsChannel,
  availabilitySearchCompletedPayloadSchema,
  availabilitySearchFailedPayloadSchema,
  availabilitySearchFiltersSchema,
  bookingRequestedPayloadSchema,
} from "./analytics-event.schema";

export type AvailabilitySearchFilters = z.infer<typeof availabilitySearchFiltersSchema>;
export type AvailabilitySearchCompletedPayload = z.infer<
  typeof availabilitySearchCompletedPayloadSchema
>;
export type AvailabilitySearchFailedPayload = z.infer<typeof availabilitySearchFailedPayloadSchema>;
export type BookingRequestedPayload = z.infer<typeof bookingRequestedPayloadSchema>;
export type AnalyticsChannelValue = (typeof AnalyticsChannel)[keyof typeof AnalyticsChannel];

export interface SearchAnalyticsContext {
  channel: AnalyticsChannelValue;
  searchId?: string;
  anonymousSessionId?: string;
  requestId?: string;
}

export type AnalyticsEventWriter = Pick<Prisma.TransactionClient, "analyticsEvent">;

export interface SearchEventInput<TPayload> {
  context: SearchAnalyticsContext & { searchId: string };
  occurredAt: Date;
  payload: TPayload;
}

export interface BookingRequestedInput {
  actorUserId: string | null;
  bookingId: string;
  channel: AnalyticsChannelValue;
  occurredAt: Date;
  payload: BookingRequestedPayload;
  searchId: string | null;
}

export interface AnalyticsEventInsertData {
  eventKey: string;
  eventType: string;
  source: string;
  occurredAt: Date;
  actorUserId?: string;
  anonymousSessionId?: string;
  requestId?: string;
  searchId?: string;
  bookingId?: string;
  payload: object;
}
