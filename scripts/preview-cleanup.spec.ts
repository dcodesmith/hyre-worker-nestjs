import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("cleanup-preview-resources.sh", () => {
  const cleanupScript = join(process.cwd(), "scripts/cleanup-preview-resources.sh");
  let temporaryDirectory: string;
  let binaryDirectory: string;
  let callsFile: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "preview-cleanup-"));
    binaryDirectory = join(temporaryDirectory, "bin");
    callsFile = join(temporaryDirectory, "calls.log");
    mkdirSync(binaryDirectory);
    writeFileSync(callsFile, "");

    writeExecutable(
      "neonctl",
      `#!/usr/bin/env bash
printf 'neon:%s\\n' "$*" >> "$CALLS_FILE"
printf '%s\\n' "\${NEON_OUTPUT:-}"
exit "\${NEON_EXIT:-0}"
`,
    );
    writeExecutable(
      "flyctl",
      `#!/usr/bin/env bash
app="$3"
printf 'fly:%s\\n' "$app" >> "$CALLS_FILE"
output="\${FLY_OUTPUT:-}"
printf '%s\\n' "\${output//__APP__/$app}"
exit "\${FLY_EXIT:-0}"
`,
    );
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function writeExecutable(name: string, contents: string): void {
    const path = join(binaryDirectory, name);
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
  }

  function runCleanup(overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync("bash", [cleanupScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALLS_FILE: callsFile,
        NEON_BRANCH: "preview/pr-185",
        NEON_PROJECT_ID: "neon-project",
        PREVIEW_APP: "hyre-worker-nestjs-pr-185",
        REDIS_APP: "hyre-worker-redis-pr-185",
        ...overrides,
      },
    });

    return {
      calls: readFileSync(callsFile, "utf8").trim().split("\n"),
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  }

  it("destroys the Neon branch and both Fly apps", () => {
    const result = runCleanup();

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "neon:branches delete preview/pr-185 --project-id neon-project",
      "fly:hyre-worker-nestjs-pr-185",
      "fly:hyre-worker-redis-pr-185",
    ]);
  });

  it("accepts the exact missing Neon branch response", () => {
    const result = runCleanup({
      NEON_EXIT: "1",
      NEON_OUTPUT: "ERROR: Branch preview/pr-185 not found.",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Neon branch 'preview/pr-185' already gone.");
  });

  it("accepts the exact missing Fly app response", () => {
    const result = runCleanup({
      FLY_EXIT: "1",
      FLY_OUTPUT: 'Could not find App "__APP__"',
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Fly app 'hyre-worker-nestjs-pr-185' already gone.");
  });

  it("fails for a missing Neon project but still destroys both Fly apps", () => {
    const result = runCleanup({
      NEON_EXIT: "1",
      NEON_OUTPUT: "Project neon-project not found.",
    });

    expect(result.status).toBe(1);
    expect(result.calls).toContain("fly:hyre-worker-nestjs-pr-185");
    expect(result.calls).toContain("fly:hyre-worker-redis-pr-185");
  });

  it("fails for a missing Fly organization", () => {
    const result = runCleanup({
      FLY_EXIT: "1",
      FLY_OUTPUT: "Organization personal not found.",
    });

    expect(result.status).toBe(1);
    expect(result.calls).toContain("fly:hyre-worker-nestjs-pr-185");
    expect(result.calls).toContain("fly:hyre-worker-redis-pr-185");
  });

  it("fails for missing Neon configuration but still destroys both Fly apps", () => {
    const result = runCleanup({ NEON_PROJECT_ID: "" });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual(["fly:hyre-worker-nestjs-pr-185", "fly:hyre-worker-redis-pr-185"]);
  });
});
