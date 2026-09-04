---
name: release
description: Inspect release status or promote a tested main commit to a versioned production release.
disable-model-invocation: true
---

# Release

Follow `docs/release-command.md` exactly.

Interpret invocation arguments as follows:

- `status` performs the read-only status workflow.
- `vMAJOR.MINOR.PATCH` prepares that explicit version.
- No argument determines the recommended next version.

Never deploy, tag, or publish outside the canonical GitHub production workflow.
