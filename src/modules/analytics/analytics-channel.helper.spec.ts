import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveHttpAnalyticsChannel } from "./analytics-channel.helper";
import { AnalyticsChannel } from "./analytics-event.schema";

describe("resolveHttpAnalyticsChannel", () => {
  it("maps the exact mobile client type to MOBILE_APP", () => {
    expect(resolveHttpAnalyticsChannel({ "x-client-type": "mobile" })).toBe(
      AnalyticsChannel.MOBILE_APP,
    );
  });

  it("maps a missing, invalid, uppercase, or repeated client type to WEB", () => {
    const headers: Array<IncomingHttpHeaders | undefined> = [
      undefined,
      {},
      { "x-client-type": "web" },
      { "x-client-type": "MOBILE" },
      { "x-client-type": "Mobile" },
      { "x-client-type": ["mobile"] },
    ];

    for (const header of headers) {
      expect(resolveHttpAnalyticsChannel(header)).toBe(AnalyticsChannel.WEB);
    }
  });
});
