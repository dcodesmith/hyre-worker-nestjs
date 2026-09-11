import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sampleBooking, sampleBookingStatusWithReview } from "./email-previews/preview-data";
import { renderBookingStatusUpdateEmail } from "./emails";

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

describe("renderBookingStatusUpdateEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("addresses the chauffeur and omits customer booking and review links", async () => {
    vi.stubEnv("WEBSITE_URL", "https://app.example.com");
    vi.stubEnv("DOMAIN", "https://example.com");

    const html = await renderBookingStatusUpdateEmail({
      ...sampleBookingStatusWithReview,
      recipientType: "chauffeur",
      recipientName: "Ada Driver",
    });

    expect(html).toContain("Ada");
    expect(html).toContain(`booking ${sampleBooking.bookingReference}`);
    expect(html).not.toContain(`/bookings/${sampleBooking.id}`);
    expect(html).not.toContain("View booking");
    expect(html).not.toContain("Your feedback");
  });

  it("keeps customer booking and review links for non-chauffeur recipients", async () => {
    vi.stubEnv("WEBSITE_URL", "https://app.example.com");
    vi.stubEnv("DOMAIN", "https://example.com");

    const html = await renderBookingStatusUpdateEmail(sampleBookingStatusWithReview);

    expect(html).toContain("Alex");
    expect(html).toContain(`/bookings/${sampleBooking.id}`);
    expect(html).toContain("View booking");
    expect(html).toContain("Your feedback");
  });
});
