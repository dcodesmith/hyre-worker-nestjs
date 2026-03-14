import { describe, expect, it } from "vitest";
import { buildBufferedBookingInterval } from "./availability-buffer.helper";

describe("buildBufferedBookingInterval", () => {
  it("applies the default 2-hour buffer on both sides", () => {
    const startDate = new Date("2026-03-10T10:00:00.000Z");
    const endDate = new Date("2026-03-10T14:00:00.000Z");

    const result = buildBufferedBookingInterval({ startDate, endDate });

    expect(result.bufferedStart.toISOString()).toBe("2026-03-10T08:00:00.000Z");
    expect(result.bufferedEnd.toISOString()).toBe("2026-03-10T16:00:00.000Z");
  });

  it("supports custom buffer hours", () => {
    const startDate = new Date("2026-03-10T10:00:00.000Z");
    const endDate = new Date("2026-03-10T14:00:00.000Z");

    const result = buildBufferedBookingInterval({ startDate, endDate }, 1);

    expect(result.bufferedStart.toISOString()).toBe("2026-03-10T09:00:00.000Z");
    expect(result.bufferedEnd.toISOString()).toBe("2026-03-10T15:00:00.000Z");
  });
});
