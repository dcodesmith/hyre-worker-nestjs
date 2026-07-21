# Verification Module — Design

Status: proposal
Scope: programmatic verification of fleet owners, chauffeurs, bank accounts, and vehicles during onboarding, consumed by hireApp via this API.

## 1. What we collect today, and what needs verifying

There is no `FleetOwner` or `Chauffeur` model — both are `User` rows. Fleet owners are users with the `fleetOwner` role plus `fleetOwnerStatus` / `hasOnboarded` / `isOwnerDriver`; chauffeurs are users with a `fleetOwnerId` and `chauffeurApprovalStatus`. Cars carry `approvalStatus`, and documents/images live in `DocumentApproval` / `VehicleImage` with a manual admin approve/reject flow (`src/modules/documents`).

| Subject | Data collected (schema) | What needs verifying | Verified today? |
|---|---|---|---|
| Fleet owner (`User`) | name, email, phone, address, `BankDetails` (bank code, account number, account name), COI doc (`CERTIFICATE_OF_INCORPORATION`), NIN doc | Identity (NIN/BVN), payout account ownership, business registration (CAC), address | No — `BankDetails.isVerified` exists but nothing sets it; payouts require it (`payment.service.ts`) |
| Chauffeur (`User` with `fleetOwnerId`) | name, phone, NIN doc, `DRIVERS_LICENSE` doc, `LASDRI` doc | Identity (NIN), FRSC driver's licence validity + expiry, photo match, (optionally) background check | No — only manual admin doc approval cascade (`document-approval.service.ts`) |
| Car | make, model, year, colour, `registrationNumber`, `MOT_CERTIFICATE`, `INSURANCE_CERTIFICATE`, images | Plate number ↔ registered owner/make/model, insurance validity (NIID), road-worthiness | No — manual admin approval only (`car-approval.service.ts`) |

Gaps that block verification (prerequisites, out of scope for this module but required):

1. **No chauffeur onboarding API** — chauffeurs are only created in test helpers via Prisma. A `POST /api/fleet-owner/chauffeurs` (create + doc upload, mirroring the car creation multipart flow) must exist before we can verify chauffeurs.
2. **No user-level document upload API** — `DocumentApproval.userId` rows (NIN, DL, LASDRI, COI) have approval cascades but no upload path.
3. **No bank details API** — nothing creates `BankDetails`.

## 2. Does mono.co do what we need?

**Yes for people and money, no for vehicles.**

### Covered by Mono (Lookup + Prove)

| Need | Mono product | Endpoint | Price/call |
|---|---|---|---|
| Chauffeur / fleet owner NIN | NIN Lookup | `POST /v3/lookup/nin` | ₦80 |
| Chauffeur driver's licence (FRSC) — returns issue/expiry dates and registry photo | Driver's Licence Lookup | `POST /v3/lookup/driver_license` | ₦60 |
| Fleet owner BVN (consent-based, OTP via NIBSS iGree) | BVN Lookup | `POST /v2/lookup/bvn/initiate` → `/verify` → `/details` | ₦45 × 3 steps |
| Payout account ownership (returns account name + linked BVN) | Account Number Lookup | `POST /v3/lookup/account-number` | ₦15 |
| Business registration (RC number, directors, status) | CAC Lookup | `GET /v3/lookup/cac` + sub-endpoints | ₦60–₦600 |
| NIN + BVN + DOB in one call | Mashup | `POST /v3/lookup/mashup` | — |
| Selfie ↔ registry photo match, liveness | Mono Prove (widget/SDK, webhook results) | `POST /v1/prove/initiate` | ₦30 + ₦100–₦500/tier |
| AML/sanctions screening (async, webhook) | Watchlist | `POST /v3/lookup/watchlist` | — |
| Address (electricity-meter database match, no field visit) | House Address Lookup | `POST /v3/lookup/address` | — |

Mechanics: `mono-sec-key` header auth, same base URL for sandbox/prod (key prefix decides), webhooks signed with `mono-webhook-secret`. Lookup access is enabled per-business by a Mono account manager — not self-serve.

Caveats: NIN lookup is "validation, not verification" — photo/address can be null; DL and NIN lookups return the registry photo but do **not** do face matching (that's Prove); BVN iGree is interactive (customer OTP), so it belongs in hireApp's onboarding UI, not a silent backend check; failed BVN lookups are still billed.

### NOT covered by Mono → supplementary providers

| Need | Recommended provider | Why |
|---|---|---|
| Plate number lookup (owner name, make, model, chassis) | **QoreID (VerifyMe)** — `POST /v1/ng/identities/license-plate-basic/{plate}` (Premium variant adds more) | Richest response, FRSC-backed; Prembly/IdentityPass is a lighter fallback |
| Physical vehicle inspection | QoreID Vehicle Verification (agent visit, photos, engine/chassis, condition) | Only programmatic road-worthiness substitute; relevant to our own vehicle-check ideas |
| Insurance validity | **NIID** (Nigerian Insurers Association) — askniid.org portal / SOAP web service (requires NIA access) | No aggregator API exists; authoritative source |
| Criminal background check (chauffeurs) | QoreID/VerifyMe "Pluto" or Prembly BGC | Semi-manual, 24–72h turnaround (routes through Police Character Certificate) — model as async |
| Physical address visit | QoreID (~20k field agents) or Youverify | Mono's address check is a meter-number database match only |
| LASDRI card validity | None (no public API) | Stays on the manual admin-approval path |

**Recommended stack: Mono (identity + bank + CAC) + QoreID (vehicle + optional background/address) + NIID (insurance, when access is negotiated).** QoreID also does DL lookup, so it's the single-vendor fallback if Mono onboarding stalls.

## 3. Module name and structure

Call it **`verification`** (`src/modules/verification`). It is the domain module hireApp talks to. Provider clients get their own modules, mirroring how `flutterwave` is a provider module consumed by `payment`:

```
src/modules/
  mono/                      # provider client, like flutterwave/
    mono.module.ts
    mono.service.ts          # createClient({ baseURL, headers: { 'mono-sec-key' }, serviceName: 'Mono' })
    mono.interface.ts
  qoreid/                    # provider client (vehicle lookups)
    qoreid.module.ts
    qoreid.service.ts
    qoreid.interface.ts
  verification/
    verification.module.ts
    verification.controller.ts          # fleet-owner-facing, /api/fleet-owner/verifications
    admin-verification.controller.ts    # /api/admin/verifications
    verification-webhook.controller.ts  # /api/verifications/webhook/mono
    guards/mono-webhook.guard.ts        # timing-safe mono-webhook-secret check (FlutterwaveWebhookGuard pattern)
    verification.service.ts             # orchestration + persistence
    identity-verification.service.ts    # NIN / BVN / DL / CAC via MonoService
    bank-verification.service.ts        # account-number resolve → BankDetails.isVerified
    vehicle-verification.service.ts     # plate lookup via QoreIdService
    verification.processor.ts           # BullMQ processor (async checks, retries)
    verification.error.ts               # AppException subclasses + VerificationErrorCode
    verification.const.ts
    verification.interface.ts
    dto/*.dto.ts                        # Zod schemas + @ZodBody/@ZodParam
```

Conventions applied (existing codebase + nestjs-best-practices skill):

- Feature module, self-contained, exports only `VerificationService`; provider services live in their own modules and are imported, never re-provided.
- Thin controllers; services throw `AppException` subclasses with stable codes (`VERIFICATION_PROVIDER_UNAVAILABLE`, `VERIFICATION_MISMATCH`, `VERIFICATION_ALREADY_PASSED`, `VERIFICATION_SUBJECT_NOT_FOUND`).
- Zod DTOs, `SessionGuard` + `RoleGuard(fleetOwner)` for owner routes, `admin`/`staff` for admin routes, signature guard for webhooks.
- Provider calls run through a new `verification` BullMQ queue with retry/backoff; controllers enqueue and return `202` with the check id, hireApp polls the status endpoint (or gets a push via the existing notification outbox). Watchlist/Prove/background checks resolve via webhook. Synchronous cheap checks (account number, ₦15) may resolve inline.
- Behind an injection token (`VERIFICATION_PROVIDER`-style abstraction is overkill for now — two concrete services suffice; revisit if we add Prembly).
- Cost control: persist every provider response (`providerResponse Json`), never re-call for an already-`PASSED` check of the same subject+type (idempotency), and cache CAC lookups.

### Schema addition

```prisma
model VerificationCheck {
  id               String                 @id @default(cuid())
  type             VerificationCheckType
  status           VerificationCheckStatus @default(PENDING)
  provider         VerificationProvider
  providerRef      String?
  providerResponse Json?
  failureReason    String?
  userId           String?
  carId            String?
  requestedById    String
  createdAt        DateTime               @default(now())
  updatedAt        DateTime               @updatedAt
  user             User?                  @relation("UserVerificationChecks", fields: [userId], references: [id])
  car              Car?                   @relation(fields: [carId], references: [id])
  requestedBy      User                   @relation("RequestedVerificationChecks", fields: [requestedById], references: [id])

  @@index([userId, type])
  @@index([carId, type])
  @@index([status])
}

enum VerificationCheckType {
  NIN
  BVN
  DRIVERS_LICENSE
  BANK_ACCOUNT
  CAC
  VEHICLE_PLATE
  INSURANCE          // NIID — pending access
  BACKGROUND_CHECK   // QoreID/Prembly — async
  FACE_MATCH         // Mono Prove
}

enum VerificationCheckStatus {
  PENDING
  PASSED
  FAILED
  NEEDS_REVIEW   // provider data returned but mismatch below threshold → admin decides
}

enum VerificationProvider {
  MONO
  QOREID
  NIID
  MANUAL
}
```

Passing checks feed the existing gates: chauffeur checks feed `chauffeurApprovalStatus`, owner checks feed `fleetOwnerStatus`/`hasOnboarded`, vehicle checks feed `approveCarIfFullyReviewed` alongside the existing doc-approval logic (a plate check becomes another required signal, like MOT/insurance docs). Manual admin approval remains the fallback (`NEEDS_REVIEW`) and the only path for LASDRI.

## 4. Endpoints

All consumed by hireApp with the existing Better Auth session; role guards as noted.

### Fleet-owner onboarding (`fleetOwner` role)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/fleet-owner/verifications/identity` | NIN (or Mashup NIN+BVN+DOB) for the fleet owner themself. Body: `{ nin, bvn?, dateOfBirth }` |
| POST | `/api/fleet-owner/verifications/bvn/initiate` | Start iGree consent flow; returns session for hireApp's OTP screen |
| POST | `/api/fleet-owner/verifications/bvn/verify` | Submit OTP; on success stores details + marks BVN check `PASSED` |
| POST | `/api/fleet-owner/verifications/business` | CAC lookup by RC number; confirms active status and that the owner is a director/shareholder |
| POST | `/api/fleet-owner/verifications/bank-account` | Resolve account number (Mono, ₦15), name-match against user + BVN cross-check → sets `BankDetails.isVerified`, `lastVerifiedAt`, `verificationResponse` |

### Chauffeur onboarding (`fleetOwner` role; chauffeur must belong to the caller)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/fleet-owner/chauffeurs/:chauffeurId/verifications/identity` | NIN lookup, name/DOB match against the chauffeur record |
| POST | `/api/fleet-owner/chauffeurs/:chauffeurId/verifications/driver-licence` | FRSC DL lookup: `{ licenseNumber, dateOfBirth, firstName, lastName }`; enforces expiry > today, stores registry photo for admin comparison |
| POST | `/api/fleet-owner/chauffeurs/:chauffeurId/verifications/background-check` | Optional/async (QoreID Pluto / Prembly BGC); resolves via webhook |

### Vehicle verification (`fleetOwner` role; car must belong to the caller) — open to refinement

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/fleet-owner/cars/:carId/verifications/vehicle` | QoreID plate lookup on `car.registrationNumber`; cross-checks make/model/owner-name against the car record and the verified owner identity |
| POST | `/api/fleet-owner/cars/:carId/verifications/insurance` | NIID policy check (stubbed `NEEDS_REVIEW` → manual until NIA access is granted) |

### Status (any authenticated subject-owner)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/fleet-owner/verifications` | List the caller's checks (own + chauffeurs + cars), filter by `type`/`status` |
| GET | `/api/fleet-owner/verifications/:checkId` | Poll a single check (hireApp polls after a `202`) |

### Admin

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/verifications` | Queue of `NEEDS_REVIEW`/`FAILED` checks (admin, staff) |
| GET | `/api/admin/verifications/:checkId` | Full provider payload incl. registry photo (admin, staff) |
| POST | `/api/admin/verifications/:checkId/override` | Manual pass/fail with notes (admin) — mirrors document approve/reject |

### Webhooks

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/verifications/webhook/mono` | Async results (Watchlist, Prove); `MonoWebhookGuard`, always ACK, handler-registry dispatch (payment webhook pattern) |
| POST | `/api/verifications/webhook/qoreid` | Async results (background checks, physical inspection) |

## 5. Other recommendations

1. **Face match** — registry photos from NIN/DL lookups are only useful if compared to a live selfie. Adopt Mono Prove (tier_1) in hireApp's chauffeur onboarding so the person holding the phone is the person on the licence.
2. **Expiry re-verification** — DL and insurance expire. Store `expiryDate` from the DL lookup and schedule re-checks/notifications via the existing `reminder` queue; auto-demote `chauffeurApprovalStatus` on lapse.
3. **Build the missing onboarding APIs first** — chauffeur CRUD, user-document upload, and bank-details endpoints are prerequisites (section 1). The verification module hangs off records those create.
4. **Watchlist screening** — cheap AML/sanctions screen on fleet owners at onboarding, given they receive payouts.
5. **New env vars** — `MONO_SECRET_KEY`, `MONO_BASE_URL`, `MONO_WEBHOOK_SECRET`, `QOREID_CLIENT_ID`, `QOREID_SECRET`, `QOREID_BASE_URL` in `envSchema`; sandbox keys work against the same base URLs.
6. **Commercials to kick off early** — Mono Lookup requires account-manager activation (sales@mono.co); NIID web-service access requires approaching the NIA. Both have lead times independent of code.
