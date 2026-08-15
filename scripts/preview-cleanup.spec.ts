import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isMissingPreviewResource,
  MISSING_RESOURCE_PATTERNS,
  summarizeCleanupStep,
} from "./preview-cleanup";

describe("isMissingPreviewResource", () => {
  it("treats a missing Neon branch as already gone", () => {
    expect(isMissingPreviewResource("ERROR: Branch preview/pr-185 not found.")).toBe(true);
  });

  it("treats a missing Fly app as already gone", () => {
    expect(isMissingPreviewResource('Could not find App "hyre-worker-nestjs-pr-185"')).toBe(true);
  });

  it("treats does-not-exist wording as already gone", () => {
    expect(isMissingPreviewResource("App does not exist")).toBe(true);
  });

  it("does not swallow auth or unexpected destroy failures", () => {
    expect(isMissingPreviewResource("Error: unauthorized")).toBe(false);
    expect(isMissingPreviewResource("failed to run query")).toBe(false);
    expect(isMissingPreviewResource("")).toBe(false);
  });
});

describe("summarizeCleanupStep", () => {
  it("reports success when the command exits 0", () => {
    expect(
      summarizeCleanupStep({
        label: "Fly app 'hyre-worker-nestjs-pr-185'",
        exitCode: 0,
        output: "Destroyed app hyre-worker-nestjs-pr-185",
      }),
    ).toEqual({
      ok: true,
      message: "Destroyed Fly app 'hyre-worker-nestjs-pr-185'.",
    });
  });

  it("reports success when the resource is already gone", () => {
    expect(
      summarizeCleanupStep({
        label: "Neon branch 'preview/pr-185'",
        exitCode: 1,
        output: "ERROR: Branch preview/pr-185 not found.",
      }),
    ).toEqual({
      ok: true,
      message: "Neon branch 'preview/pr-185' already gone.",
    });
  });

  it("reports failure for unexpected errors", () => {
    const result = summarizeCleanupStep({
      label: "Fly app 'hyre-worker-redis-pr-185'",
      exitCode: 1,
      output: "Error: unauthorized",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Failed to destroy");
    expect(result.message).toContain("unauthorized");
  });
});

describe("cleanup-preview-resources.sh", () => {
  it("keeps bash missing-resource needles in sync with the helper", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/cleanup-preview-resources.sh"),
      "utf8",
    );

    for (const pattern of MISSING_RESOURCE_PATTERNS) {
      expect(script).toContain(pattern);
    }
  });
});
