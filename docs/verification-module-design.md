# Verification Module — Design

Status: proposal (revised)
Scope: programmatic verification of fleet owners, chauffeurs, bank accounts, and vehicles during onboarding, consumed by hireApp via this API. Goal: seamless onboarding with the least friction — the backend does the heavy lifting.

## 0. GitHub access

I can't authenticate a new GitHub account from inside this cloud agent — there's no interactive login here, and this run is scoped to the `hyre-worker-nestjs` repo via an injected token. To give me access to the `dcodesmith/hyre` repo, the cleanest options are:

- Add `dcodesmith/hyre` to this Cloud Agent's environment/repo config in the Cursor dashboard (Cloud Agents settings), or start an agent from that repo, so the token is scoped to it; or
- Add a GitHub token as a Cloud Agent secret (Dashboard → Cloud Agents → Secrets) and tell me the env var name.

Note: everything about onboarding, fleet owners, chauffeurs, and cars already lives in **this** repo (`hyre-worker-nestjs`) — the audit below is complete without `hyre`. If `hyre` is the mobile/hireApp client, I only need it to confirm the client-side onboarding screens, not the verification logic.

## 1. What we collect today, and what needs verifying

There is no `FleetOwner` or `Chauffeur` model — both are `User` rows. Fleet owners are users with the `fleetOwner` role plus `fleetOwnerStatus` / `hasOnboarded` / `isOwnerDriver`; chauffeurs are users with a `fleetOwnerId` and `chauffeurApprovalStatus`. Cars carry `approvalStatus`, and documents/images live in `DocumentApproval` / `VehicleImage` with a manual admin approve/reject flow (`src/modules/documents`).

| Subject | Data collected (schema) | What needs verifying | Verified today? |
|---|---|---|---|
| Fleet owner (`User`) | name, email, phone, address, `BankDetails`, COI doc, NIN doc | Identity (NIN), payout account ownership | No — `BankDetails.isVerified` exists but nothing sets it; payouts require it (`payment.service.ts`) |
| Chauffeur (`User` w/ `fleetOwnerId`) | name, phone, NIN doc, `DRIVERS_LICENSE` doc, `LASDRI` doc | NIN + driver's licence, with **name, address and phone cross-matching** across both | No — only manual admin doc approval cascade |
| Car | make, model, year, colour, `registrationNumber`, MOT/insurance docs, images | Plate ↔ make/model/colour/year (owner confirms), roadworthiness, insurance, registration | No — manual admin approval only |

Prerequisites that don't exist yet (out of scope for this module but required before it can run):

1. **No chauffeur onboarding API** — chauffeurs are only created in test helpers. Need `POST /api/fleet-owner/chauffeurs`.
2. **No user-level document upload API** — `DocumentApproval.userId` rows (NIN, DL, LASDRI, COI) have approval cascades but no upload path.
3. **No bank details API** — nothing creates `BankDetails`.

## 2. Chauffeur verification — NIN + driver's licence cross-match

Per the decision, chauffeur verification is exactly this, no background check for now:

1. Look up **NIN** (Mono `POST /v3/lookup/nin`, ₦80) → returns names, DOB, phone, residential address, photo.
2. Look up **driver's licence** (Mono `POST /v3/lookup/driver_license`, ₦60) → returns names, DOB, issue/expiry dates, photo, state of issue.
3. **Cross-match** the two results and the chauffeur's account:
   - **Name** matches across NIN and DL (normalised: case, ordering, diacritics, common short forms; fuzzy score with a threshold).
   - **Address** on NIN matches the address the chauffeur/fleet owner entered (NIN carries residential address; the DL lookup does not reliably return address, so address matching is NIN ↔ our record).
   - **Phone** on NIN matches the chauffeur's account phone number (normalised to E.164 / local).
   - **DOB** matches across NIN and DL (free, high-signal, worth adding).
   - **Licence not expired** (`expiry_date > today`).
4. Outcome: all match → `PASSED`; hard field fails (expired licence, name mismatch) → `FAILED`; soft mismatch (e.g. address differs, phone differs) → `NEEDS_REVIEW` for an admin, so we never hard-block a real driver on a stale NIN phone number.

Result feeds `chauffeurApprovalStatus`. Store `expiry_date` so the reminder queue can re-check and auto-demote on lapse.

Why Mono here: it's the one vendor that returns both NIN and FRSC driver's licence in a single integration, cheaply, with the registry data we need to cross-match. Note the lookups return the **registry photo** but do not do a selfie/face match — if we later want to prove the person is the licence holder, add Mono Prove (tier_1) selfie/liveness in hireApp. Not required for the first cut.

## 3. Vehicle verification — plate lookup + confirm + document upload

The three portals you gave are all reachable and I tested them against `fkj528hb`:

| Portal | Request | Response for `fkj528hb` | Automatable? |
|---|---|---|---|
| **autoreg.ng** registration (`verify.autoreg.ng`) | `POST /` form: `regNumber=fkj528hb` + a `__RequestVerificationToken` (anti-forgery cookie+field pair scraped from the GET first) | **Make** Toyota, **Model** Corolla, **Colour** Black, **Chassis** JTDBL40E99J048770, Vehicle Licence issue 26/08/2025 → expiry 26/08/2026 | **Yes** — no captcha; the login form has a reCAPTCHA but the verify POST does not. Repeatable. |
| **DVIS roadworthiness** (`dvis.lg.gov.ng/verify/api.php`) | `POST reg_no=fkj528hb` | `{"status":"1","message":"Valid RWC","RwcNo":"17232128","RwcExp":"2026-08-24","RwcStatus":"1","VehCate":"P"}`. Invalid plate → `{"status":"2","message":"Vehicle does not exist"}` | **Yes** — plain unauthenticated JSON API. Cleanest of the three. |
| **NIID insurance** (`askniid.org/VerifyPolicy.aspx`) | ASP.NET WebForms multi-step postback | — | **No** — Google reCAPTCHA v2 gate (sitekey `6LdH9KsUAAAAAF5jyoBBntwVxmRc6gINc9aj_CgL`). Cannot be called headlessly. Use the official API or a reseller (below). |

Note: autoreg gives make/model/colour/chassis but **not year of manufacture** in the response we saw. To show year, either derive it from the chassis/VIN (10th VIN char = model year; here `9` decodes plausibly) or ask the owner to enter it and treat it as unverified. DVIS `VehCate: "P"` = private category — relevant because Lagos e-hailing rules expect commercial use; flag `P` for review.

### Insurance (NIID) — how to verify without the captcha

Do **not** scrape or captcha-solve askniid.org (brittle + Cybercrimes Act / terms exposure). Two legitimate paths:

- **Reseller now:** Prembly `POST https://api.prembly.com/verification/insurance_policy` (header `x-api-key`, body `{channel, number}` where `number` is the **policy number**). Returns policy number, reg number, cover type, make/model/colour/chassis, issue/expiry dates, status. Sandbox test policy `AAO/24/4/00000/20`. Ship with this — it's a documented REST wrapper over NIID data.
- **Direct later:** the NIA runs an official SOAP/HTTP web service at `https://niid.org/NIA_API/Service.asmx`, operation `Vehicle_PolicyVerification(SearchString, SearchType, Username, Password)` — plate or policy number, credentials issued by the NIA (email info@nigeriainsurers.org). No self-serve signup; commercial/MOU process. Switch to this when granted, keep Prembly as failover.

Because NIID needs the policy number, collect the policy number (it's on the certificate; OCR it from the upload) and cross-check the returned reg number against the plate.

### The onboarding flow (fleet owner adding a car)

Designed for minimum clicks:

1. Owner enters **plate number** only.
2. Backend calls autoreg + DVIS (parallel) → shows **make, model, colour, chassis, RWC status/expiry, licence expiry** for the owner to confirm ("Is this your car?").
3. Owner confirms → we persist the fetched details onto the `Car` (pre-filling make/model/colour/registration so they don't type them) and the plate check is `PASSED`.
4. Then ask for the **insurance certificate, roadworthiness certificate, and vehicle registration** uploads (see legal note below).
5. On upload, cross-check: insurance policy number → NIID/Prembly (cover type must be comprehensive for e-hailing); roadworthiness cert number → matches DVIS `RwcNo`/expiry; registration → matches autoreg make/model/chassis. Mismatches → `NEEDS_REVIEW`.

### Do we still need document uploads if the portals confirm validity? Yes.

Database verification alone is **not** legally sufficient in Lagos — keep both the uploads and the automated checks:

- **Lagos e-hailing/taxi Guidelines (2020)** require the operator to hold, per vehicle: proof of ownership/registration, **roadworthiness certificate**, **comprehensive insurance policy**, vehicle licence, hackney permit; the Lagos Ministry of Transportation is also granted access to the operator's database. So we're expected to *hold the documents*, not just assert we checked a website.
- **NRTR 2012 fleet-operator rules (Regs. 199–202)** require operators of 5+ vehicles to register with FRSC and maintain records of drivers/vehicles for inspection.
- **Evidentiary value:** the portals show *current* status only. If there's a claim or litigation about a past trip, our proof is the document the owner presented **plus** a timestamped verification snapshot — a live re-query later proves nothing about the trip date. Under the Evidence Act (s.84) we also need to keep the raw API response + timestamp to certify system-generated records.
- **NDPA 2023:** collecting these is fine — lawful basis is legal obligation + passenger-safety legitimate interest. Just minimise (collect only the mandated docs), set a retention schedule (engagement + ~6 years), store the raw verification payloads, and record it in the privacy notice.

So: **automated portal checks are the fraud filter and the pre-fill/low-friction mechanism; the uploads are the legal record.** The upload proves what the owner presented; the portal proves it's genuine; we store both.

### QoreID — dropped

We agreed not to use QoreID: fleet owners are frequently **not** the registered owner of the car, so an identity-match-to-owner product doesn't fit. The government portals verify the *vehicle* regardless of who's onboarding it, which is exactly what we want.

### Which service gives the most info about a car?

Between the three: **autoreg.ng is the richest** (make, model, colour, chassis/VIN, licence validity) and is the best single source for vehicle identity. **DVIS** is the authoritative and cleanest source specifically for roadworthiness (and its own JSON API). **NIID** is authoritative for insurance but only reachable via API/reseller. Use all three for their respective domains rather than picking one — together they fully cover registration + roadworthiness + insurance. There isn't a single portal that returns all of registration, roadworthiness and insurance in one call.

## 4. Module name and structure

Call it **`verification`** (`src/modules/verification`) — the domain module hireApp talks to. External clients get their own provider modules, mirroring how `flutterwave` is a provider module consumed by `payment`:

```
src/modules/
  mono/                          # provider client (NIN, driver's licence, bank account)
    mono.module.ts
    mono.service.ts              # createClient({ baseURL, headers: { 'mono-sec-key' }, serviceName: 'Mono' })
    mono.interface.ts
  vehicle-registry/              # government-portal clients (autoreg, DVIS)
    vehicle-registry.module.ts
    autoreg.service.ts           # GET for anti-forgery token+cookie, then POST regNumber; parse modal HTML
    dvis.service.ts              # POST reg_no → JSON
    vehicle-registry.interface.ts
  insurance-registry/            # NIID via Prembly now, NIA web service later
    insurance-registry.module.ts
    prembly.service.ts
    insurance-registry.interface.ts
  verification/
    verification.module.ts
    verification.controller.ts          # /api/fleet-owner/verifications, /chauffeurs/:id/..., /cars/:id/...
    admin-verification.controller.ts    # /api/admin/verifications
    chauffeur-verification.service.ts   # NIN + DL lookup + cross-match
    bank-verification.service.ts        # account-number resolve → BankDetails.isVerified
    vehicle-verification.service.ts     # autoreg + DVIS + insurance orchestration
    verification.service.ts             # persistence + status
    verification.processor.ts           # BullMQ processor (retries, portal flakiness)
    verification.error.ts               # AppException subclasses + VerificationErrorCode
    verification.const.ts
    verification.interface.ts
    dto/*.dto.ts                         # Zod schemas + @ZodBody/@ZodParam
```

Conventions (existing codebase + the nestjs-best-practices skill):

- Feature module, self-contained, exports only `VerificationService`; provider services live in their own modules and are imported, never re-provided.
- Thin controllers; services throw `AppException` subclasses with stable codes (`VERIFICATION_PROVIDER_UNAVAILABLE`, `VERIFICATION_MISMATCH`, `VERIFICATION_PLATE_NOT_FOUND`, `VERIFICATION_ALREADY_PASSED`, `VERIFICATION_SUBJECT_NOT_FOUND`).
- Zod DTOs; `SessionGuard` + `RoleGuard(fleetOwner)` on owner routes, `admin`/`staff` on admin routes.
- Government-portal calls are flaky/rate-limited HTML/JSON scrapes — wrap them in the shared `HttpClientService`, run them through a `verification` BullMQ queue with retry/backoff, and **cache** by plate so repeat onboarding steps don't re-hit the portals. The plate lookup itself is fast enough to run inline (owner is waiting on the confirm screen); insurance/reseller calls can resolve inline or async.
- Idempotency + cost control: persist every provider/portal response (`providerResponse Json`); never re-call for an already-`PASSED` check of the same subject+type.

### Schema addition

```prisma
model VerificationCheck {
  id               String                  @id @default(cuid())
  type             VerificationCheckType
  status           VerificationCheckStatus @default(PENDING)
  provider         VerificationProvider
  providerRef      String?
  providerResponse Json?
  failureReason    String?
  matchDetails     Json?                    // per-field match results (name/address/phone/dob)
  expiresAt        DateTime?                // licence/RWC/insurance expiry for re-check scheduling
  userId           String?
  carId            String?
  requestedById    String
  createdAt        DateTime                 @default(now())
  updatedAt        DateTime                 @updatedAt
  user             User?                    @relation("UserVerificationChecks", fields: [userId], references: [id])
  car              Car?                     @relation(fields: [carId], references: [id])
  requestedBy      User                     @relation("RequestedVerificationChecks", fields: [requestedById], references: [id])

  @@index([userId, type])
  @@index([carId, type])
  @@index([status])
}

enum VerificationCheckType {
  NIN
  DRIVERS_LICENSE
  CHAUFFEUR_IDENTITY   // combined NIN+DL cross-match result
  BANK_ACCOUNT
  VEHICLE_PLATE        // autoreg registration lookup
  ROADWORTHINESS       // DVIS
  INSURANCE            // NIID via Prembly / NIA
}

enum VerificationCheckStatus {
  PENDING
  PASSED
  FAILED
  NEEDS_REVIEW         // soft mismatch → admin decides
}

enum VerificationProvider {
  MONO
  AUTOREG
  DVIS
  NIID
  PREMBLY
  MANUAL
}
```

Passing checks feed the existing gates: chauffeur checks → `chauffeurApprovalStatus`; bank check → `BankDetails.isVerified`; vehicle checks (plate + roadworthiness + insurance) become required signals in `approveCarIfFullyReviewed` alongside the existing MOT/insurance doc approvals. Manual admin approval stays the `NEEDS_REVIEW` fallback and the only path for LASDRI (no public API).

## 5. Endpoints

All consumed by hireApp with the existing Better Auth session; role guards as noted.

### Chauffeur (`fleetOwner` role; chauffeur must belong to caller)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/fleet-owner/chauffeurs/:chauffeurId/verify` | Runs NIN + driver's licence lookup and the name/address/phone/DOB cross-match in one call. Body: `{ nin, licenseNumber, dateOfBirth, firstName, lastName }`. Returns the combined result + per-field match detail. Drives `chauffeurApprovalStatus`. |

### Vehicle (`fleetOwner` role; car must belong to caller)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/fleet-owner/vehicles/lookup` | **Step 1** — body `{ plateNumber }`. Calls autoreg + DVIS, returns make/model/colour/chassis/year + RWC status/expiry + licence expiry for the owner to confirm. No car row required yet. |
| POST | `/api/fleet-owner/cars/:carId/verify-plate` | **Step 3** — owner confirmed; persist fetched details onto the car, mark `VEHICLE_PLATE` + `ROADWORTHINESS` checks. (Or fold into car creation so the confirm step creates the car.) |
| POST | `/api/fleet-owner/cars/:carId/verify-insurance` | **Step 5** — body `{ policyNumber }` (OCR-prefilled from the uploaded certificate); Prembly/NIID lookup, cross-check reg number + cover type. |

The document uploads themselves reuse the existing car document-upload path (the prerequisite user/car document API), so the verify endpoints only handle the lookups and cross-checks.

### Fleet owner (`fleetOwner` role)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/fleet-owner/verifications/identity` | NIN lookup for the fleet owner, name/DOB match against their account. |
| POST | `/api/fleet-owner/verifications/bank-account` | Resolve account number (Mono, ₦15), name-match → sets `BankDetails.isVerified`, `lastVerifiedAt`, `verificationResponse`. |

### Status (subject owner)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/fleet-owner/verifications` | List the caller's checks (own + chauffeurs + cars), filter by `type`/`status`. |
| GET | `/api/fleet-owner/verifications/:checkId` | Poll a single check. |

### Admin

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/verifications` | Queue of `NEEDS_REVIEW`/`FAILED` checks (admin, staff). |
| GET | `/api/admin/verifications/:checkId` | Full provider payload incl. registry photos (admin, staff). |
| POST | `/api/admin/verifications/:checkId/override` | Manual pass/fail with notes (admin) — mirrors document approve/reject. |

No webhooks needed in this cut: NIN/DL/bank/portal lookups are all synchronous. (Add a `/webhook/*` route only if we later adopt Mono Prove or an async background check.)

## 6. Other recommendations

1. **Build the prerequisite onboarding APIs first** — chauffeur create, user-document upload, bank-details. The verification module hangs off records they create.
2. **Portal resilience** — autoreg is HTML-scraped and DVIS/NIID are third-party government sites; expect downtime and markup changes. Wrap in retries, cache by plate, alert on parse failures, and always allow the admin `NEEDS_REVIEW` manual path so a portal outage never fully blocks onboarding.
3. **Year of manufacture** — not returned by autoreg; derive from VIN (10th char) or collect from the owner as unverified.
4. **Comprehensive-cover check** — Lagos e-hailing requires comprehensive insurance; check the NIID/Prembly `type_of_cover`, not just that a policy exists.
5. **Expiry re-verification** — store `expiresAt` for licence, RWC, and insurance; the existing `reminder` queue re-checks and auto-demotes chauffeur/car status on lapse.
6. **New env vars** — `MONO_SECRET_KEY`, `MONO_BASE_URL`; `AUTOREG_BASE_URL`, `DVIS_BASE_URL`; `PREMBLY_API_KEY`, `PREMBLY_BASE_URL` (and later `NIID_WS_URL`/`NIID_USERNAME`/`NIID_PASSWORD`) in `envSchema`.
7. **Commercials to start early** — Mono Lookup needs account-manager activation (sales@mono.co); NIA/NIID direct access needs an MOU (info@nigeriainsurers.org). Prembly is self-serve to unblock insurance in the meantime.
8. **Face match (optional, later)** — NIN/DL lookups return the registry photo but don't match a selfie. Add Mono Prove tier_1 in hireApp if we want to prove the driver is the licence holder.

## Appendix — verified portal request/response samples (plate `fkj528hb`)

DVIS roadworthiness (`POST https://dvis.lg.gov.ng/verify/api.php`, body `reg_no=fkj528hb`):

```json
{ "status": "1", "message": "Valid RWC", "RwcNo": "17232128", "RwcExp": "2026-08-24", "RwcStatus": "1", "VehCate": "P" }
```

autoreg (`POST https://verify.autoreg.ng/`, body `regNumber=fkj528hb` + `__RequestVerificationToken`): HTML modal with `Vehicle Make: Toyota`, `Vehicle Model: Corolla`, `Vehicle Color: Black`, `Chassis: JTDBL40E99J048770`, service table row `Vehicle License | ₦1,875.00 | 26/08/2025 | 26/08/2026`.

NIID: reCAPTCHA v2 blocked — use Prembly `insurance_policy` or the NIA web service instead.
