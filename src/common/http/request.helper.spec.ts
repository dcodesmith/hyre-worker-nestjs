import { describe, expect, it, vi } from "vitest";
import { getRequestOrigin } from "./request.helper";

describe("getRequestOrigin", () => {
  it("uses x-forwarded-proto when present", () => {
    const request = {
      headers: { "x-forwarded-proto": "https" },
      protocol: "http",
      get: vi.fn().mockReturnValue("api.example.com"),
    } as never;

    expect(getRequestOrigin(request)).toBe("https://api.example.com");
  });

  it("falls back to request protocol when forwarded proto is absent", () => {
    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
    } as never;

    expect(getRequestOrigin(request)).toBe("http://localhost:3000");
  });
});
