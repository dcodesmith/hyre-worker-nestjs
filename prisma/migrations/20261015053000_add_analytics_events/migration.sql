CREATE TABLE "AnalyticsEvent" (
    "id" UUID NOT NULL,
    "eventKey" VARCHAR(200) NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID,
    "anonymousSessionId" UUID,
    "requestId" VARCHAR(128),
    "searchId" UUID,
    "bookingId" UUID,
    "payload" JSONB NOT NULL,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnalyticsEvent_eventKey_key" ON "AnalyticsEvent"("eventKey");
CREATE INDEX "AnalyticsEvent_eventType_occurredAt_idx" ON "AnalyticsEvent"("eventType", "occurredAt");
CREATE INDEX "AnalyticsEvent_searchId_idx" ON "AnalyticsEvent"("searchId");
CREATE INDEX "AnalyticsEvent_bookingId_idx" ON "AnalyticsEvent"("bookingId");
CREATE INDEX "AnalyticsEvent_actorUserId_occurredAt_idx" ON "AnalyticsEvent"("actorUserId", "occurredAt");
