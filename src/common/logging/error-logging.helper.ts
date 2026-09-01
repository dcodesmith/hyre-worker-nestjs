type SafeErrorCode = string | number;

export type SerializedLogError = {
  type: string;
  message: string;
  stack?: string;
  code?: SafeErrorCode;
};

export function getErrorMessage(value: unknown, fallback = "Unknown error"): string {
  if (value instanceof Error) {
    return value.message.trim() || value.name || fallback;
  }
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  return fallback;
}

export function toLogError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(getErrorMessage(value, "Non-Error value thrown"));
}

export function serializeErrorForLog(value: unknown): SerializedLogError {
  const error = toLogError(value);
  const errorWithCode = error as Error & { code?: unknown; errorCode?: unknown };
  const code = errorWithCode.code ?? errorWithCode.errorCode;

  return {
    type: error.name || "Error",
    message: error.message,
    ...(error.stack && { stack: error.stack }),
    ...((typeof code === "string" || typeof code === "number") && { code }),
  };
}

export function toPersistedErrorMessage(value: unknown, maxLength = 500): string {
  return getErrorMessage(value).slice(0, maxLength);
}
