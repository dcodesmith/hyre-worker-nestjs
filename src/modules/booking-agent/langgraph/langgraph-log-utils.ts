const STACK_SNIPPET_MAX_CHARS = 600;

export interface NormalizedNodeError {
  errorName: string;
  errorMessage: string;
  errorCode?: string;
  stackSnippet?: string;
}

export function normalizeNodeError(error: unknown): NormalizedNodeError {
  if (!(error instanceof Error)) {
    return {
      errorName: "UnknownError",
      errorMessage: String(error),
    };
  }

  const maybeCode = (error as { code?: unknown }).code;
  const errorCode = typeof maybeCode === "string" ? maybeCode : undefined;
  const stackSnippet = error.stack?.slice(0, STACK_SNIPPET_MAX_CHARS);

  return {
    errorName: error.name || "Error",
    errorMessage: error.message,
    errorCode,
    stackSnippet,
  };
}
