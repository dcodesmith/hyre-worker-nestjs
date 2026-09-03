---
description: Inspect or promote a tested main commit to a versioned production release
argument-hint: "[status|vMAJOR.MINOR.PATCH]"
disable-model-invocation: true
---

Follow `docs/release-command.md` exactly.

Treat `$ARGUMENTS` as the optional command argument:

- `status` performs the read-only status workflow.
- `vMAJOR.MINOR.PATCH` prepares that explicit version.
- No argument determines the recommended next version.

Never deploy, tag, or publish outside the canonical GitHub production workflow.
