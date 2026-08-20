# Environments

`main` deploys to long-lived **dev**, not production.

| Env | Lifetime | Fly app | Database | URL |
| --- | --- | --- | --- | --- |
| Preview | While the PR is open | `hyre-worker-nestjs-pr-<n>` | Neon branch `preview/pr-<n>` | `https://hyre-worker-nestjs-pr-<n>.fly.dev` |
| Dev | Always on | `hyre-worker-nestjs` | Persistent Neon DB behind that app | `https://hyre-worker-nestjs.fly.dev` |
| Prod | Not created yet | New app later | New Neon project later | `api.tripdly.com` later |

## Rules

- Preview and dev stay on test keys and the existing Fly/Neon project.
- Do not point preview or local `DATABASE_URL` at a future prod database.
- When a Neon `dev` branch exists, set `parent_branch` on the preview `create-branch-action` steps so PRs fork **dev**, not a later prod branch. Leave it unset until that branch exists; an invented name breaks previews.
- Production is a second Fly app, second Neon project, and a protected GitHub `production` environment. Do not rename `hyre-worker-nestjs` into prod.

## Merge this PR

Create a GitHub Environment named `development` and copy any environment-scoped vars/secrets from `production`. Repo-level secrets keep working.
