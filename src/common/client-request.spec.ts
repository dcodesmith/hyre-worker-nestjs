import { describe, expect, it } from "vitest";
import { readClientRequest, stampClientHeaders } from "./client-request";

const SECRET = "edge-secret-value";

describe("readClientRequest", () => {
  it("uses the Cloudflare IP and country when the edge secret matches", () => {
    expect(
      readClientRequest(
        {
          "x-hyre-edge": SECRET,
          "cf-connecting-ip": "203.0.113.10",
          "fly-client-ip": "172.16.1.4",
          "cf-ipcountry": "ng",
          "user-agent": "Hyre/1",
        },
        SECRET,
      ),
    ).toEqual({
      ipAddress: "203.0.113.10",
      userAgent: "Hyre/1",
      country: "NG",
    });
  });

  it("ignores a spoofed Cloudflare IP when the edge secret is missing", () => {
    expect(
      readClientRequest(
        {
          "cf-connecting-ip": "203.0.113.10",
          "cf-ipcountry": "NG",
          "fly-client-ip": "198.51.100.20",
          "user-agent": "Mobile/1",
        },
        undefined,
      ),
    ).toEqual({
      ipAddress: "198.51.100.20",
      userAgent: "Mobile/1",
      country: null,
    });
  });

  it("drops unknown country codes", () => {
    expect(
      readClientRequest(
        {
          "x-hyre-edge": SECRET,
          "cf-connecting-ip": "203.0.113.10",
          "cf-ipcountry": "XX",
        },
        SECRET,
      ).country,
    ).toBeNull();
  });

  it("replaces a caller-supplied client IP header", () => {
    const headers = {
      "x-hyre-client-ip": "203.0.113.99",
      "fly-client-ip": "198.51.100.20",
    };

    stampClientHeaders(headers, undefined);

    expect(headers["x-hyre-client-ip"]).toBe("198.51.100.20");
    expect(headers["x-hyre-country"]).toBeUndefined();
  });
});
