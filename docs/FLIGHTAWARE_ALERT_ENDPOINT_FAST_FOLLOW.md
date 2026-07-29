# FlightAware Alert Endpoint Fast Follow

## Status

Account endpoint configuration is required before production rollout. Flight-scoped webhook authentication is implemented.

## Why this is required

FlightAware requires an AeroAPI account to have a default alert callback URL configured through:

```text
PUT /alerts/endpoint
```

This is account-level configuration. It is performed once per FlightAware account/API key and repeated only when the callback domain changes.

Individual alerts can provide `target_url`. That URL overrides the account default, but FlightAware still documents default endpoint registration as an initial prerequisite.

## Current application behavior

- Alert creation sends a per-alert `target_url`.
- The callback is `POST /api/webhooks/flightaware`.
- Each target URL contains a `flightId` and an HMAC signature scoped to that flight.
- `FLIGHTAWARE_WEBHOOK_SECRET` signs callbacks locally and is never sent to FlightAware.
- Callback processing requires the signed flight ID, callback `alert_id`, and active local alert to match.
- Incoming webhook URLs have query strings removed from application logs.
- The application does not configure the account-wide endpoint automatically.

Relevant code:

- `src/modules/flightaware/flightaware-alert.service.ts`
- `src/modules/flightaware/guards/flightaware-webhook.guard.ts`
- `src/modules/flightaware/flightaware.controller.ts`

## Manual account setup

Do not place real keys or webhook secrets in this repository, tickets, screenshots, or shared shell history.

```bash
curl -X PUT \
  "https://aeroapi.flightaware.com/aeroapi/alerts/endpoint" \
  -H "x-apikey: ${FLIGHTAWARE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data "{\"url\":\"${FLIGHTAWARE_CALLBACK_URL}\"}"
```

Expected response: HTTP `204 No Content`.

Use the bare public callback route for the account default. Application-created alerts override it with their own signed `target_url`; an unsigned fallback callback is intentionally rejected.

Verify the stored endpoint:

```bash
curl \
  "https://aeroapi.flightaware.com/aeroapi/alerts/endpoint" \
  -H "x-apikey: ${FLIGHTAWARE_API_KEY}"
```

The callback must:

- Use public HTTPS.
- Reach the deployed NestJS service.
- Return HTTP `200` for an accepted callback.
- Preserve the `/api/webhooks/flightaware` route.

## Implemented security model

Each alert URL receives an unguessable HMAC signature derived from its local flight ID. A leaked URL can target only its associated flight and cannot authenticate callbacks for another flight.

Disabling the local alert rejects future callbacks. Rotating `FLIGHTAWARE_WEBHOOK_SECRET` invalidates every existing signature, so active FlightAware alerts must be recreated when it changes.

Do not automatically update the account-wide endpoint during application startup. An AeroAPI account can be shared by multiple environments, so a preview deployment could overwrite the production default.

## Proposed rollout order

1. Inspect `GET /alerts` and `GET /alerts/endpoint` before deployment.
2. If legacy `?secret=` alerts exist, deploy a temporary compatibility release that accepts both legacy and signed callbacks. Do not deploy the HMAC-only guard first.
3. Deploy the signed callback and configure `PUT /alerts/endpoint` for the production AeroAPI account before creating or recreating alerts.
4. Recreate legacy alerts with signed target URLs and verify their callbacks.
5. Remove temporary legacy callback support after all legacy alerts are gone. If no legacy alerts existed, skip the compatibility release.
6. Create a test flight alert and verify fleet-owner/chauffeur delivery and the customer-impact policy.

## Acceptance criteria

- The FlightAware account endpoint is configured and can be retrieved with `GET /alerts/endpoint`.
- Every new alert has a flight-scoped callback signature.
- A signature cannot authenticate a callback for another flight or `alert_id`.
- Disabled alerts are rejected.
- Callback URLs and credentials do not appear in logs.
- Duplicate callbacks remain idempotent.
- Production and non-production accounts/endpoints cannot overwrite each other.

## References

- [AeroAPI developer portal](https://uk.flightaware.com/aeroapi/portal#overview)
- [Official AeroAPI OpenAPI specification](https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml)
