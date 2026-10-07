import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBookingAgentServiceUnavailableMessage,
  isBookingAgentServiceUnavailableMessage,
} from "./conversation.const";

describe("booking-agent service unavailable message", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes the configured WEBSITE_URL in the outage text", () => {
    vi.stubEnv("WEBSITE_URL", "https://hyre-web-development.tripdly.workers.dev");

    expect(getBookingAgentServiceUnavailableMessage()).toBe(
      "This service is temporarily unavailable. Please try again in a moment or type booking online at https://hyre-web-development.tripdly.workers.dev.",
    );
  });

  it("still classifies a persisted outage message after WEBSITE_URL changes", () => {
    const persisted =
      "This service is temporarily unavailable. Please try again in a moment or type booking online at https://legacy.example.com.";

    vi.stubEnv("WEBSITE_URL", "https://tripdly.com");

    expect(isBookingAgentServiceUnavailableMessage(persisted)).toBe(true);
    expect(getBookingAgentServiceUnavailableMessage()).not.toContain("legacy.example.com");
  });
});
