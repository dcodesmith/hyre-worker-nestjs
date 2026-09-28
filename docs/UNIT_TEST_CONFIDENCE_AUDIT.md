# Unit test confidence audit

Audit of the unit suite on 27 September 2026, followed by removal of the tests that did not improve
confidence. Production code was not changed. No new end-to-end test was added: chauffeur
onboarding, account verification, vehicle verification, and admin approval already exercise those
flows against the app and database with third-party providers mocked.

The question was what share of unit tests does not improve confidence: tests that only mirror
implementation, assert wiring or forwarding, repeat another case, or check framework behavior.

## Result

About **9.8%** of unit tests add little or no incremental confidence. The other **90.2%** protect
observable behavior: domain rules, security, money, concurrency, idempotency, retries, or provider
contracts.

| | Count |
| --- | ---: |
| Unit spec files | 276 |
| Executed unit cases (`pnpm exec vitest run`) | 2,956 |
| Low-value cases | 289 |
| Valuable cases | 2,667 |
| Unit suite duration | 23.01s (2,956 passed) |
| E2E spec files | 36 |
| E2E `it` / `test` blocks | 377 |

The 289 low-value cases come from reading every unit spec. Vitest reports 2,956 executed cases
because some `it.each` rows expand beyond the named blocks used in a few slices. Sampled extra
rows were boundary checks, so they stay in the valuable count. The headline percentage is
`289 / 2,956`.

## Classification

A case is **low-value** when it is one of these:

- Construction, existence, or Nest wiring smoke.
- An assertion that restates the implementation or a constant.
- A fully mocked call that only checks the next function was invoked.
- A duplicate of a case that already covers the same risk.
- A test of framework or library behavior, or a test with no meaningful assertion.

A case is **valuable** when a plausible product change would fail it: a business invariant, a
security or authorization rule, a boundary, an error mapping, retry or idempotency behavior, or a
third-party response contract.

## Where the low-value tests sit

| Slice | Executed or named cases | Low-value | Share |
| --- | ---: | ---: | ---: |
| Notifications, reminders, schedulers, processors | 451 | 93 | 20.6% |
| Auth, verification, chauffeur, cars, documents, reviews | 922 | 83 | 9.0% |
| Scripts, config, shared helpers, observability | 259 | 24 | 9.3% |
| AI search, booking agent, maps, Flutterwave, jobs, storage | 447 | 38 | 8.5% |
| Booking, payment, rates, promotions, referrals | 837 | 51 | 6.1% |

The weak pockets are thin controllers, queue adapters, static module wiring, template and WhatsApp
SID matrices, duplicated DTO cases, exception getter specs, prompt substring checks, and fixture
self-tests.

Examples that can be removed or folded into an existing flow test:

- Controller specs that only assert a mocked service was called and its return value was echoed.
- Scheduler specs that only assert `queue.add` received a job name.
- `Chauffeur` exception specs that compare getters with constants.
- Repeated `createAccountVerificationSchema` cases already covered by the stage schemas.
- WhatsApp tests that only check each template uses its configured SID.
- Email helper tests that only trim a string or copy a field.

Examples that should stay as unit tests:

- Booking cutoff, pricing, and promotion window boundaries.
- Idempotency key reuse and in-progress `Retry-After` behavior.
- Payment amount mismatch blocking confirmation.
- Guest booking responses that do not reveal whether a booking exists.
- Webhook signature comparison and provider status classification.
- Outbox claim races, retry backoff, and dead-letter boundaries.
- Chauffeur and account-verification provider failure, expiry, and identity-mismatch rules.

## Existing flow coverage

The requested style of test already exists. `test/chauffeur-invitation.e2e-spec.ts` boots the
application, uses the database, and mocks Twilio, Mono, Smile ID, storage, and email. It covers
invite, consent, session isolation, provider success, duplicate NIN rejection, idempotency, and
assignment conflicts. Account verification, vehicle verification, and admin approval have the same
shape.

## Cleanup

Removed **282** executed cases (2,956 down to 2,674) and **28** spec files. The unit suite still
passes, in 20.10s. Domain, security, money, concurrency, idempotency, retry, and provider-contract
tests stayed.

Two small groups from the low-value list were kept because they are the only checks of a real rule:

- Flutterwave webhook dispatch, so a charge, transfer, or refund cannot be routed to the wrong
  handler and an unknown event stays ignored.
- The booking-receipt throttler, so that route uses only the default limit and does not inherit
  the public AI-search limit.

Flow coverage was left as it is. The gaps those deleted tests occupied were mock forwarding and
duplicated schema cases, which the existing end-to-end flows already exercise at the HTTP boundary.
