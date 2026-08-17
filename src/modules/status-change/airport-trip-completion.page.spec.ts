import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  renderAirportCompletionInvalidPage,
  renderAirportCompletionPage,
} from "./airport-trip-completion.page";

const booking = {
  id: "booking-1",
  bookingReference: "REF-1",
  status: BookingStatus.ACTIVE,
  pickupLocation: "Murtala <script>alert(1)</script>",
  returnLocation: "Victoria Island",
  completedAt: null,
  car: { make: "Toyota", model: "Camry", year: 2024 },
};

describe("airport trip completion page", () => {
  it("does not complete the trip on GET and escapes booking details", () => {
    const html = renderAirportCompletionPage(booking, 'secret-"token');

    expect(html).toContain("Confirm trip completed");
    expect(html).toContain('action="/chauffeur/airport-trips/booking-1/complete"');
    expect(html).toContain('name="token" value="secret-&quot;token"');
    expect(html).toContain("Murtala &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows a completed trip without a confirm button", () => {
    const html = renderAirportCompletionPage(
      {
        ...booking,
        status: BookingStatus.COMPLETED,
        completedAt: new Date("2026-08-17T12:00:00.000Z"),
      },
      "secret-token",
    );

    expect(html).toContain("Trip already completed");
    expect(html).not.toContain("<form");
  });

  it("renders an invalid-link page", () => {
    expect(renderAirportCompletionInvalidPage()).toContain("invalid or no longer active");
  });
});
