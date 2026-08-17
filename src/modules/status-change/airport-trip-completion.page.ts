import { BookingStatus } from "@prisma/client";

export type AirportCompletionPageBooking = {
  bookingReference: string;
  status: BookingStatus;
  pickupLocation: string;
  returnLocation: string;
  completedAt: Date | null;
  car: { make: string; model: string; year: number };
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

export function renderAirportCompletionInvalidPage(): string {
  return layout(
    "Trip link unavailable",
    "<h1>This trip link is invalid or no longer active.</h1><p>Ask the fleet owner if you still need to complete the trip.</p>",
  );
}

export function renderAirportCompletionPage(
  booking: AirportCompletionPageBooking,
  token: string,
): string {
  const car = `${booking.car.make} ${booking.car.model} (${booking.car.year})`;
  const details = `<p>Booking ${escapeHtml(booking.bookingReference)}</p>
    <p>${escapeHtml(car)}</p>
    <p>Pickup: ${escapeHtml(booking.pickupLocation)}</p>
    <p>Drop-off: ${escapeHtml(booking.returnLocation)}</p>`;

  if (booking.status === BookingStatus.COMPLETED) {
    const completedAt = booking.completedAt
      ? `<p>Completed at ${escapeHtml(booking.completedAt.toISOString())}</p>`
      : "";
    return layout("Trip completed", `<h1>Trip already completed</h1>${details}${completedAt}`);
  }

  return layout(
    "Complete airport trip",
    `<h1>Confirm trip completed</h1>
    ${details}
    <p>Open this page after drop-off, then confirm. Opening the link does not complete the trip.</p>
    <form method="post" action="?token=${encodeURIComponent(token)}">
      <button type="submit">Confirm trip completed</button>
    </form>`,
  );
}
