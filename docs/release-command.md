# Release command

The repository skill at `.agents/skills/release/SKILL.md` is a safe frontend for
`.github/workflows/fly-production.yml`. Invoke it as `/release` in Cursor or `$release` in Codex.
Claude does not currently document automatic `.agents/skills/` discovery; Claude users must ask it
to follow the Skill file explicitly. The GitHub workflow is the only path that deploys production,
whether the release starts from an agent, the GitHub Actions UI, or `gh`.

## Commands

- `/release status` reports release and deployment state without making changes.
- `/release` prepares and dispatches the next production release after confirmation.
- `/release vMAJOR.MINOR.PATCH` uses an explicit version after validating it.

Use the equivalent `$release` forms in Codex.

## Source of truth

- A version is officially released only when a non-draft GitHub release and matching tag exist.
- If no official release exists, the project is unreleased and the first stable version is
  `v1.0.0`.
- Otherwise, the latest stable GitHub release is the version baseline.
- The release candidate is a commit contained in `main` that has passed CI and the automatic
  development deployment.
- `package.json` is development metadata; it does not prove that a production release exists.

## Version recommendation

Inspect all commits from the latest release tag, exclusive, through the candidate commit:

1. A `BREAKING CHANGE:` footer or `type!:` title proposes a major bump.
2. Otherwise, a `feat:` title proposes a minor bump.
3. Otherwise, any releasable change proposes a patch bump.
4. If there are no changes since the latest release, stop.

An explicit version must use stable semantic version format `vMAJOR.MINOR.PATCH`, be greater than
the latest release, and not already exist.

## Status workflow

For `/release status`:

1. Read the latest stable GitHub release and tag.
2. Find the latest successful `main` development deployment and its commit SHA.
3. Check CI for that SHA.
4. Show the current production version, candidate SHA, proposed next version, and blocking checks.
5. Do not dispatch a workflow or mutate GitHub, Fly, or Neon.

## Release workflow

1. Fetch the latest remote `main` and tags without changing local files.
2. Select the latest `main` commit that passed CI and deployed successfully to development.
3. Determine or validate the next version.
4. Show the version, candidate SHA, and commit summary.
5. Ask for confirmation before dispatching production.
6. Dispatch only the canonical workflow:

   ```bash
   gh workflow run fly-production.yml \
     --ref main \
     -f ref=<candidate-sha> \
     -f version=<vMAJOR.MINOR.PATCH>
   ```

7. Monitor the workflow. If it waits for the protected `production` environment, ask the user to
   approve it in GitHub; never bypass that gate.
8. Report the deployment and GitHub release URLs when complete.

Do not run `flyctl deploy`, create a tag, publish a GitHub release, or modify Neon directly. The
production workflow owns migrations, deployment, health verification, tagging, and release notes.

## What the production workflow guarantees

The workflow:

1. Validates the version and confirms the candidate belongs to `main`.
2. Re-runs unit tests, type checking, and the build.
3. Waits for GitHub production-environment approval.
4. Creates a temporary Neon safety branch.
5. Migrates Neon `main` and deploys the candidate to the production Fly app.
6. Verifies the production root and health endpoints.
7. Only after a healthy deployment, creates the version tag and GitHub release.

## Manual release

The command is optional. To release manually, open GitHub Actions, select **Deploy Production**,
choose the workflow from `main`, enter the tested `main` SHA and version, run it, and approve the
protected production environment.

For an emergency rollback, deploy the chosen earlier `main` SHA as a new patch release so release
history remains monotonic.
