import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("cleanup-preview-r2-objects.sh", () => {
  const cleanupScript = join(process.cwd(), "scripts/cleanup-preview-r2-objects.sh");
  let temporaryDirectory: string;
  let binaryDirectory: string;
  let callsFile: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "preview-r2-cleanup-"));
    binaryDirectory = join(temporaryDirectory, "bin");
    callsFile = join(temporaryDirectory, "calls.log");
    mkdirSync(binaryDirectory);
    writeFileSync(callsFile, "");
    writeExecutable(
      "rclone",
      `#!/usr/bin/env bash
printf 'rclone:%s\\n' "$*" >> "$CALLS_FILE"
printenv | grep -E '^(AWS_|RCLONE_CONFIG_R2_)' | sort >> "$CALLS_FILE"
exit "\${RCLONE_EXIT:-0}"
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
        PREVIEW_PREFIX: "previews/pr-185/",
        R2_ACCOUNT_ID: "account-id",
        R2_ACCESS_KEY_ID: "r2-access-key",
        R2_SECRET_ACCESS_KEY: "r2-secret-key",
        R2_IMAGES_BUCKET_NAME: "hyre-assets-images-development",
        R2_DOCS_BUCKET_NAME: "hyre-assets-docs-development",
        AWS_ACCESS_KEY_ID: "should-not-leak",
        AWS_SECRET_ACCESS_KEY: "should-not-leak",
        AWS_REGION: "eu-west-2",
        ...overrides,
      },
    });

    return {
      calls: readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean),
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  }

  it("deletes only the preview prefix from both development buckets", () => {
    const result = runCleanup();

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        "rclone:delete r2:hyre-assets-images-development/previews/pr-185/",
        "rclone:delete r2:hyre-assets-docs-development/previews/pr-185/",
        "RCLONE_CONFIG_R2_TYPE=s3",
        "RCLONE_CONFIG_R2_PROVIDER=Cloudflare",
        "RCLONE_CONFIG_R2_ACCESS_KEY_ID=r2-access-key",
        "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=r2-secret-key",
        "RCLONE_CONFIG_R2_ENDPOINT=https://account-id.r2.cloudflarestorage.com",
      ]),
    );
    expect(result.calls.join("\n")).not.toContain("AWS_ACCESS_KEY_ID");
    expect(result.calls.join("\n")).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(result.calls.join("\n")).not.toContain("AWS_REGION");
    expect(result.output).toContain(
      "Deleted preview objects from 'hyre-assets-images-development'.",
    );
    expect(result.output).toContain("Deleted preview objects from 'hyre-assets-docs-development'.");
  });

  it("rejects an invalid preview prefix before rclone runs", () => {
    const result = runCleanup({ PREVIEW_PREFIX: "previews/pr-185" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Invalid preview storage prefix.");
    expect(result.calls).toEqual([]);
  });

  it("fails closed when R2 configuration is missing", () => {
    const result = runCleanup({ R2_ACCESS_KEY_ID: "" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("R2_ACCESS_KEY_ID is unset.");
    expect(result.calls).toEqual([]);
  });

  it("continues to the docs bucket if images cleanup fails", () => {
    const result = runCleanup({ RCLONE_EXIT: "1" });

    expect(result.status).toBe(1);
    expect(result.calls.filter((line) => line.startsWith("rclone:"))).toEqual([
      "rclone:delete r2:hyre-assets-images-development/previews/pr-185/",
      "rclone:delete r2:hyre-assets-docs-development/previews/pr-185/",
    ]);
    expect(result.output).toContain(
      "Failed to delete preview objects from 'hyre-assets-images-development':",
    );
  });
});
