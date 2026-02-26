import { describe, expect, it } from "vitest";
import { WhatsAppToolInputValidationException } from "../whatsapp-agent.error";
import {
  parseWhatsAppAgentToolInput,
  whatsappAgentDefinedToolDefinitions,
  whatsappAgentEnabledToolDefinitions,
  whatsappAgentEnabledToolNames,
  whatsappAgentToolSchemas,
} from "./tool-definitions";

describe("whatsapp tool definitions", () => {
  it("exposes defined tools for all configured schemas", () => {
    expect(whatsappAgentDefinedToolDefinitions.length).toBe(
      Object.keys(whatsappAgentToolSchemas).length,
    );
  });

  it("exposes only enabled tool definitions for this phase", () => {
    expect(whatsappAgentEnabledToolDefinitions.map((tool) => tool.name)).toEqual([
      ...whatsappAgentEnabledToolNames,
    ]);
  });

  it("parses valid search_vehicles payload", () => {
    const parsed = parseWhatsAppAgentToolInput("search_vehicles", {
      pickupDate: "2026-03-10",
      bookingType: "DAY",
      pickupTime: "9:00 AM",
      pickupLocation: "The George Hotel, Ikoyi",
      dropoffLocation: "The George Hotel, Ikoyi",
      vehicleCategory: "LUXURY_SUV",
    });

    expect(parsed.pickupDate).toBe("2026-03-10");
    expect(parsed.bookingType).toBe("DAY");
    expect(parsed.pickupLocation).toBe("The George Hotel, Ikoyi");
    expect(parsed.dropoffLocation).toBe("The George Hotel, Ikoyi");
    expect(parsed.vehicleCategory).toBe("LUXURY_SUV");
  });

  it("throws for invalid tool payload", () => {
    expect(() =>
      parseWhatsAppAgentToolInput("search_vehicles", {
        pickupDate: "2026-03-10",
        unknownField: true,
      }),
    ).toThrow(WhatsAppToolInputValidationException);
  });
});
