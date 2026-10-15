# Demand instrumentation

Tripdly records full-intent availability searches and booking requests as append-only
`AnalyticsEvent` rows. A full-intent search has a booking type and a complete availability
interval.

## Channels

`AnalyticsEvent.source` is the product channel:

- `WEB`
- `MOBILE_APP`
- `WHATSAPP`

HTTP requests are classified as mobile only when `X-Client-Type` is exactly `mobile`; all other
HTTP requests are classified as web. WhatsApp supplies its channel internally.

## Search-to-booking contract

Web and mobile clients must:

1. Read `searchId` from the search response body or `X-Search-Id` response header.
2. Reuse it while refining the same search journey.
3. Include it as `searchId` when requesting a booking.
4. Start a new journey without reusing an old `searchId`.

WhatsApp attaches the exact full-intent search ID to every option displayed from that search,
including system-generated alternatives, and copies it into the booking request when an option is
selected. Alternative queries are not recorded as customer demand.

Bookings without a valid, joined search ID are direct or unattributed bookings. Partial WhatsApp
exploration is intentionally outside this first version because it does not yet describe a
bookable availability interval.

## Conversion definition

For each channel:

- Denominator: distinct `searchId` values from `AVAILABILITY_SEARCH_COMPLETED`.
- Numerator: distinct `bookingId` values from `BOOKING_REQUESTED` whose non-null `searchId` joins
  to a completed search.
- Attribution: use the joined search event's channel, including a journey that finishes booking
  through a different channel.

Do not count search-event rows as the denominator. One search journey can produce multiple rows
when its filters change. `AVAILABILITY_SEARCH_FAILED` is an operational reliability signal and is
excluded from conversion.

## Reliability

Search telemetry is fail-open so analytics cannot break search. `BOOKING_REQUESTED` is written in
the booking transaction so the booking and its demand event commit or roll back together.
