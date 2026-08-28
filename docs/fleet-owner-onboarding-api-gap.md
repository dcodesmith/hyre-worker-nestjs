# Fleet-owner onboarding API gap

Status: gap analysis and contract proposal

Reviewed: 28 August 2026

Related: [Verification module design](./verification-module-design.md)

## Purpose

`hireApp` currently owns fleet-owner onboarding directly: it reads and writes
Prisma, uploads files, calls Flutterwave, and redirects incomplete owners away
from the fleet console. That behavior cannot be migrated safely to `hyre-web`
until the API owns the workflow.

This document separates the prerequisite onboarding contract from the
verification-provider work described in the verification module design.

## Current product behavior in `hireApp`

The existing flow is:

1. The user signs in through email OTP and receives the `fleetOwner` role.
2. The parent `/fleet-owner` route checks `hasOnboarded`.
3. An incomplete owner is redirected to `/fleet-owner/onboarding`.
4. The owner chooses one of two account types:
   - **Fleet Owner** — manages multiple vehicles and chauffeurs.
   - **Owner-Driver** — drives one vehicle and cannot add chauffeurs.
5. Both account types provide:
   - name or business name;
   - Nigerian phone number;
   - address or business address;
   - bank and ten-digit account number;
   - confirmation that the account belongs to them.
6. Owner-drivers additionally upload:
   - NIN document;
   - driver's licence;
   - optional LASDRI card.
7. The bank account is resolved through Flutterwave.
8. The application creates verified bank details, creates pending personal
   document records where applicable, sets `hasOnboarded = true`, and redirects
   to the fleet console.

`hasOnboarded` unlocks the portal immediately. `fleetOwnerStatus` does not block
portal access; it controls whether the owner's approved cars can appear in
public search. Owner-driver documents can therefore remain pending after the
portal is unlocked.

The current fleet-owner login collects terms acceptance but does not persist
`termsAcceptedAt` or `privacyAcceptedAt`. The API migration should correct that
gap rather than reproduce it.

## What the API already supports

The following runtime contracts are available:

- fleet-owner OTP signup/sign-in and role assignment;
- `GET|PATCH /api/users/me` for basic profile fields;
- fleet-owner car list, detail, multipart creation, update, and rejected-file
  replacement;
- manual admin car and document approval/rejection;
- owner-driver single-car enforcement;
- dashboard, earnings, payout-history, and promotion operations;
- public inventory filtering that requires:
  - `Car.approvalStatus = APPROVED`;
  - `User.fleetOwnerStatus = APPROVED`;
  - `User.hasOnboarded = true`.

The Prisma schema already contains `hasOnboarded`, `isOwnerDriver`,
`fleetOwnerStatus`, consent timestamps, `BankDetails`, user-linked
`DocumentApproval` records, and chauffeur relationships.

## What is missing

There is currently no callable API that:

- reads authoritative fleet-owner onboarding state;
- selects or changes the account type;
- persists fleet-owner terms and privacy acceptance;
- creates, reads, updates, or verifies bank details;
- uploads or replaces fleet-owner and owner-driver documents;
- validates onboarding prerequisites and sets `hasOnboarded`;
- approves, places on hold, or archives a fleet owner;
- enforces onboarding completion on fleet-owner operational endpoints;
- creates, lists, reads, or updates chauffeurs;
- uploads chauffeur documents.

No runtime service updates `hasOnboarded` or `fleetOwnerStatus`. Consequently,
without manual database changes, a new fleet owner cannot complete the API-owned
workflow or become visible in public inventory.

The existing chauffeur directory contains DTO/config/error stubs, but no
controller, service, or module. User-linked document approval cascades exist,
but there is no fleet-owner upload endpoint that creates those records.

PR #164 is design-only. It proposes identity, bank, chauffeur, vehicle, and
admin verification endpoints, but does not implement their prerequisite record
creation or onboarding transitions.

## Product decisions required

These decisions must be explicit in the API contract:

1. **Fleet-owner identity requirements**

   `hireApp` does not collect identity or company documents from a non-driving
   fleet owner. Decide whether this account type requires personal NIN,
   CAC/certificate of incorporation, or both.

2. **Meaning of onboarding completion**

   Preserve the existing behavior unless product requirements change:
   `hasOnboarded` means the required information was accepted, not that every
   admin or provider verification passed.

3. **Pending-owner permissions**

   The existing behavior allows a pending owner to prepare cars and chauffeurs
   while preventing public inventory visibility. If retained, expose this as
   explicit capabilities instead of making the web infer it.

4. **Account-type mutability**

   Decide whether an owner can switch between Fleet Owner and Owner-Driver
   after onboarding, especially after cars, chauffeurs, or bookings exist.

## Minimal onboarding contract

Build these contracts before the verification module.

### Read onboarding state

`GET /api/fleet-owner/onboarding`

The response should expose only transport-safe fields:

```json
{
  "status": "NOT_STARTED",
  "accountType": null,
  "profile": {
    "name": null,
    "phoneNumber": null,
    "address": null
  },
  "bankDetails": null,
  "documents": [],
  "capabilities": {
    "manageCars": false,
    "manageChauffeurs": false,
    "receivePayouts": false,
    "publishCars": false
  }
}
```

Suggested transport statuses are `NOT_STARTED`, `IN_PROGRESS`, `SUBMITTED`,
`NEEDS_ACTION`, and `COMPLETE`. They may be derived from existing records; a new
database enum is not required unless persistence provides a demonstrated
benefit.

The response must include rejection notes for actionable documents and return
masked bank details only.

Use this endpoint as the authoritative source for the web onboarding middleware.
Do not rely only on mutable fields embedded in Better Auth's cached session
cookie, because onboarding changes must take effect immediately.

### Save profile and account type

`PATCH /api/fleet-owner/onboarding`

```json
{
  "accountType": "OWNER_DRIVER",
  "name": "Example Name",
  "phoneNumber": "+2349012341234",
  "address": "Lagos, Nigeria",
  "acceptTerms": true,
  "acceptPrivacy": true
}
```

The API must set consent timestamps from server time. It must not accept
client-supplied timestamps.

Use `FLEET_OWNER` and `OWNER_DRIVER` as the transport values. Map them to the
existing `isOwnerDriver` field inside the service.

### Create and verify bank details

`PUT /api/fleet-owner/bank-details`

```json
{
  "bankCode": "044",
  "accountNumber": "0123456789",
  "accountOwnershipConfirmed": true
}
```

The API should resolve the account, store the provider-returned account name,
and set `isVerified` itself. It must not trust a client-supplied account name or
verification flag.

The response should contain the resolved account name, bank name, masked
account number, verification status, and any retryable state. A bank-list
endpoint should be added if the provider, rather than a versioned API constant,
is authoritative for supported bank codes.

### Upload owner documents

`POST /api/fleet-owner/documents`

Multipart fields:

- `documentType`;
- `file`.

Initially supported types depend on the account-type decision, but the existing
owner-driver behavior requires `NIN`, `DRIVERS_LICENSE`, and optional `LASDRI`.
Fleet-owner requirements may add `CERTIFICATE_OF_INCORPORATION`.

Rejected files need the owner-scoped equivalent of the existing car replacement
contract:

`PUT /api/fleet-owner/documents/:documentId/file`

Only a rejected document owned by the caller may be replaced. Replacement
returns it to `PENDING` and clears stale approval metadata.

### Complete onboarding

`POST /api/fleet-owner/onboarding/complete`

This endpoint must:

1. lock or atomically condition the user row;
2. verify that profile, account type, consent, and verified bank details exist;
3. verify that documents required for the selected account type exist;
4. set `hasOnboarded = true` idempotently;
5. return the updated onboarding state and capabilities.

Do not duplicate provider verification in this endpoint. It validates persisted
results and performs the state transition.

### Admin fleet-owner review

At minimum:

- `GET /api/admin/fleet-owners`;
- `GET /api/admin/fleet-owners/:fleetOwnerId`;
- `PATCH /api/admin/fleet-owners/:fleetOwnerId/status`.

The status mutation must support the existing `PROCESSING`, `APPROVED`,
`ON_HOLD`, and `ARCHIVED` states with review notes and audit metadata. Public
inventory remains restricted to approved owners.

## Capability enforcement

The API remains the authorization source of truth. Web middleware is a UX guard,
not the business control.

Recommended semantics matching `hireApp`:

- unauthenticated: no fleet-owner access;
- wrong role: no fleet-owner access;
- `hasOnboarded = false`: onboarding endpoints only;
- onboarded Owner-Driver:
  - may manage one car;
  - may not create or manage chauffeurs;
- onboarded Fleet Owner:
  - may manage cars and chauffeurs;
- `fleetOwnerStatus != APPROVED`:
  - may prepare owned resources;
  - cannot publish cars to public inventory;
- unverified bank details:
  - cannot receive payouts.

Expose these rules as response capabilities, but enforce them again in API
guards/services. Never authorize solely from capability values returned earlier
to the client.

## Chauffeur and vehicle dependencies

Once the initial owner onboarding contract is available:

1. implement chauffeur list/create/detail/update and user-document upload;
2. connect chauffeur verification from the verification module design;
3. retain the existing car multipart creation contract as the manual fallback;
4. add plate lookup and confirmation before car creation;
5. connect roadworthiness and insurance verification;
6. keep admin review and file retention as fallback/legal-record paths.

`hyre-mobile` is customer-only and provides no fleet-owner onboarding reference.
Use the API for contracts and `hireApp` for current browser behavior.

## Recommended delivery order

1. Onboarding state read and profile/account-type mutation.
2. Bank resolution and persistence.
3. Owner document upload/replacement.
4. Atomic completion and fleet-owner API capability enforcement.
5. Admin fleet-owner review.
6. Chauffeur CRUD and uploads.
7. Verification module.
8. Plate-led vehicle onboarding.

The first four steps form the smallest independently verifiable slice that lets
`hyre-web` redirect a newly authenticated fleet owner through onboarding before
showing the fleet console.
