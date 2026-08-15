/**
 * Classifies preview-teardown command output so "already gone" is success.
 * Keep these needles in sync with scripts/cleanup-preview-resources.sh.
 */
export const MISSING_RESOURCE_PATTERNS = [
  "not found",
  "could not find app",
  "could not find",
  "does not exist",
  "no app found",
  "app not found",
] as const;

export function isMissingPreviewResource(output: string): boolean {
  const normalized = output.toLowerCase();
  return MISSING_RESOURCE_PATTERNS.some((needle) => normalized.includes(needle));
}

export function summarizeCleanupStep(input: { label: string; exitCode: number; output: string }): {
  ok: boolean;
  message: string;
} {
  if (input.exitCode === 0) {
    return { ok: true, message: `Destroyed ${input.label}.` };
  }

  if (isMissingPreviewResource(input.output)) {
    return { ok: true, message: `${input.label} already gone.` };
  }

  return {
    ok: false,
    message: `Failed to destroy ${input.label}: ${input.output}`.trim(),
  };
}
