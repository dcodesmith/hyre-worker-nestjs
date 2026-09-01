import { describe, expect, it } from "vitest";
import {
  getErrorMessage,
  serializeErrorForLog,
  toLogError,
  toPersistedErrorMessage,
} from "./error-logging.helper";

describe("error logging helpers", () => {
  it("extracts messages only from safe scalar values", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage(" failed ")).toBe("failed");
    expect(getErrorMessage(12)).toBe("12");
    expect(getErrorMessage({ token: "secret" })).toBe("Unknown error");
    expect(getErrorMessage(null)).toBe("Unknown error");
  });

  it("normalizes non-Error throws without serializing their payload", () => {
    const error = toLogError({ token: "secret" });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Non-Error value thrown");
    expect(error.message).not.toContain("secret");
  });

  it("serializes only the supported Error fields", () => {
    const error = Object.assign(new Error("provider failed"), {
      code: "E_PROVIDER",
      config: { headers: { authorization: "Bearer secret" } },
    });

    expect(serializeErrorForLog(error)).toEqual({
      type: "Error",
      message: "provider failed",
      stack: error.stack,
      code: "E_PROVIDER",
    });
    expect(
      serializeErrorForLog(Object.assign(new Error("app failed"), { errorCode: "APP_FAILED" }))
        .code,
    ).toBe("APP_FAILED");
  });

  it("bounds persisted error messages", () => {
    expect(toPersistedErrorMessage(new Error("abcdef"), 4)).toBe("abcd");
    expect(toPersistedErrorMessage({ response: "secret" })).toBe("Unknown error");
  });
});
