import type { DomainOutboxEventType } from "@prisma/client";

export type DomainOutboxJobData = {
  outboxEventId: string;
  eventType: DomainOutboxEventType;
  aggregateId: string;
  dispatchAttempt: number;
};
