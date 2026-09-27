import { describe, expect, it } from "vitest";
import { filterSessionResponse } from "./auth.config";

describe("filterSessionResponse", () => {
  it("removes stored client context from session responses", () => {
    const response = {
      user: { id: "user-1" },
      session: {
        id: "session-1",
        ipAddress: "203.0.113.10",
        userAgent: "Hyre/1",
        country: "NG",
      },
    };

    expect(filterSessionResponse("/get-session", response)).toEqual({
      user: { id: "user-1" },
      session: { id: "session-1" },
    });
    expect(filterSessionResponse("/update-session", response)).toEqual({
      user: { id: "user-1" },
      session: { id: "session-1" },
    });
    expect(filterSessionResponse("/list-sessions", [response.session])).toEqual([
      { id: "session-1" },
    ]);
    expect(filterSessionResponse("/sign-in/email-otp", response)).toBeUndefined();
  });
});
