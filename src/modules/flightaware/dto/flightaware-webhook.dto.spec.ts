import { describe, expect, it } from "vitest";
import { flightAwareWebhookSchema } from "./flightaware-webhook.dto";

describe("flightAwareWebhookSchema", () => {
  it("accepts the AeroAPI v4 alert callback shape", () => {
    const result = flightAwareWebhookSchema.parse({
      alert_id: 123,
      event_code: "change",
      long_description: "Flight information changed.",
      short_description: "Flight changed",
      summary: "Change",
      flight: {
        fa_flight_id: "BAW74-20300101",
        ident: "BA74",
        origin: "EGLL",
        origin_iata: "LHR",
        destination: "DNMM",
        destination_iata: "LOS",
        scheduled_in: "2030-01-01T10:00:00.000Z",
        estimated_in: "2030-01-01T10:40:00.000Z",
        gate_destination: "G2",
        terminal_destination: null,
      },
    });

    expect(result).toMatchObject({
      alert_id: 123,
      event_code: "change",
      flight: {
        scheduled_in: "2030-01-01T10:00:00.000Z",
        estimated_in: "2030-01-01T10:40:00.000Z",
        gate_destination: "G2",
        terminal_destination: null,
      },
    });
  });

  it("rejects the non-AeroAPI event_type callback shape", () => {
    const result = flightAwareWebhookSchema.safeParse({
      alert_id: "alert-123",
      event_type: "arrival",
      event_time: "2030-01-01T10:00:00.000Z",
      flight: {
        fa_flight_id: "BAW74-20300101",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts change callbacks and preserves explicit nullable location fields", () => {
    const result = flightAwareWebhookSchema.parse({
      alert_id: 123,
      event_code: "change",
      long_description: "Flight is active again.",
      short_description: "Flight changed",
      summary: "Change",
      flight: {
        fa_flight_id: "BAW74-20300101",
        gate_destination: null,
        terminal_destination: null,
      },
    });

    expect(result.event_code).toBe("change");
    expect(result.flight).toMatchObject({
      gate_destination: null,
      terminal_destination: null,
    });
  });
});
