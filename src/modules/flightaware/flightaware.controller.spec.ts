import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { FlightAwareController } from "./flightaware.controller";
import { FlightSearchThrottlerGuard } from "./flightaware-throttler.guard";
import { FlightAwareWebhookGuard } from "./guards/flightaware-webhook.guard";

describe("FlightAwareController", () => {
  it("applies FlightSearchThrottlerGuard on search-flight only", () => {
    const searchGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      FlightAwareController.prototype.searchFlight,
    );
    const webhookGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      FlightAwareController.prototype.handleFlightAwareWebhook,
    );

    expect(searchGuards).toContain(FlightSearchThrottlerGuard);
    expect(webhookGuards).toContain(FlightAwareWebhookGuard);
    expect(webhookGuards).not.toContain(FlightSearchThrottlerGuard);
  });
});
