# Environments

`main` is the only long-lived code branch. It deploys automatically to development and is
manually promoted to production after verification and approval.

| Env | Lifetime | Fly app | Database | URL |
| --- | --- | --- | --- | --- |
| Preview | While the PR is open | `hyre-worker-nestjs-pr-<n>` | Neon `preview/pr-<n>`, forked from `development` | `https://hyre-worker-nestjs-pr-<n>.fly.dev` |
| Development | Always on | `hyre-worker-nestjs` | Neon `development` | `https://hyre-worker-nestjs.fly.dev` |
| Production | Always on after launch | `hyre-worker-nestjs-production` | Neon `main` | `https://hyre-worker-nestjs-production.fly.dev` |

## Rules

- Preview and development use non-production credentials and isolated Redis instances.
- Production uses a dedicated Redis instance and production integration credentials.
- Never point preview, local, or development `DATABASE_URL` at Neon `main`.
- Neon `main` must be protected. Preview branches are disposable; `development` is long-lived.
- Production migrations must be backward-compatible with the previous app release. A Neon safety
  branch is a recovery snapshot, not a substitute for expand-and-contract migrations.

## Automatic development deployment

`.github/workflows/fly-deploy.yml` runs after a merge to `main` or by manual dispatch. It creates or
reuses Neon `development`, stages its pooled and direct database URLs on the existing Fly app, runs
the release migration, and deploys the selected `main` code.

## First production deployment

Before running the production workflow:

1. Configure the protected GitHub `production` environment with a required reviewer.
2. Add an app-scoped `FLY_API_TOKEN` and Neon `NEON_API_KEY` to that environment.
3. Configure `hyre-worker-nestjs-production` with production secrets required by
   `src/config/env.config.ts`. This includes a dedicated `REDIS_URL`, email, Twilio, Flutterwave,
   auth, storage, FlightAware, Google Maps, and AI credentials.
4. Confirm payment and Twilio webhook destinations use the production Fly URL.
5. Keep `ENABLE_MANUAL_TRIGGERS=false`.

Do not reuse the development Redis URL: both environments run queue processors and would consume
each other's jobs.

Production uses the Fly-managed Upstash database `hyre-worker-production` on the Fixed 250MB plan
in `lhr`. Eviction and automatic plan upgrades are disabled. Queue producers must keep completed
and failed history bounded; current defaults retain at most 100 completed and 50 failed jobs.
Review capacity at 60% usage and plan an upgrade before 80%.

## Releasing production

Production can be released manually or with `/release`. Both routes dispatch
`.github/workflows/fly-production.yml`; the command does not bypass GitHub Actions or the protected
production environment.

For a manual release, open GitHub Actions, choose **Deploy Production** from `main`, and enter:

- `ref`: a tested commit SHA contained in `main`.
- `version`: a new stable semantic version such as `v1.0.0`.

The workflow:

1. Validates that the version is new and greater than existing versions.
2. Confirms that the selected commit is contained in `main`.
3. Re-runs unit tests, type checking, and the build.
4. Waits for approval from the GitHub `production` environment.
5. Creates a 14-day Neon safety branch from `main`.
6. Stages Neon `main` pooled and direct URLs without printing credentials.
7. Runs Prisma migrations in the Fly release command and deploys the selected commit.
8. Verifies the root response reports `production` and the health endpoint succeeds.
9. Creates the version tag and GitHub release with generated release notes.

The tag is created only after production is healthy. A failed test, rejected approval, failed
migration, failed deployment, or failed health check does not create a release.

For an application rollback, deploy the chosen earlier `main` SHA as a new patch release through
the same workflow. Only roll back across database migrations that remain compatible with that
earlier application version.

When a custom API domain is introduced, update `DOMAIN`, `AUTH_BASE_URL`, `TRUSTED_ORIGINS`,
`TWILIO_WEBHOOK_URL`, and `FLUTTERWAVE_WEBHOOK_URL` together in `fly.production.toml`.

## Release versions

The service is currently unreleased development software. `package.json` uses `0.1.0` as
development metadata, but the first official stable production release will be `v1.0.0`.

`/release` in Cursor or Claude inspects commits since the latest GitHub release and recommends:

- `fix:` proposes a patch version.
- `feat:` proposes a minor version.
- `type!:` or a `BREAKING CHANGE:` footer proposes a major version.

The command shows the candidate SHA, proposed version, and changes before asking for confirmation.
It then dispatches the same manual production workflow and waits for the GitHub environment
approval. `/release status` is read-only, and `/release v1.2.3` requests an explicit version.

The complete agent contract and manual procedure are in
[`docs/release-command.md`](release-command.md).
