import { describe, expect, it } from "vitest";
import { getDevLanOriginPatterns, isOriginAllowed, originMatchesPattern } from "./origin-pattern";

describe("origin-pattern", () => {
  describe("getDevLanOriginPatterns", () => {
    it("returns LAN wildcards only for development", () => {
      const dev = getDevLanOriginPatterns("development");
      expect(dev).toContain("http://192.168.*.*:*");
      expect(dev).toContain("http://10.*.*.*:*");
      expect(dev).toContain("http://172.*.*.*:*");
      expect(dev).toContain("http://127.0.0.1:*");
      expect(dev).toContain("http://localhost:*");
    });

    it("returns an empty list outside development", () => {
      expect(getDevLanOriginPatterns("production")).toEqual([]);
      expect(getDevLanOriginPatterns("test")).toEqual([]);
      expect(getDevLanOriginPatterns(undefined)).toEqual([]);
    });
  });

  describe("originMatchesPattern", () => {
    it("matches exact origins ignoring path/trailing slash", () => {
      expect(originMatchesPattern("https://example.com", "https://example.com/")).toBe(true);
      expect(originMatchesPattern("https://example.com:443", "https://example.com")).toBe(true);
      expect(originMatchesPattern("https://other.com", "https://example.com")).toBe(false);
    });

    it("rejects malformed origins", () => {
      expect(originMatchesPattern("not-a-url", "https://example.com")).toBe(false);
      expect(originMatchesPattern("", "https://example.com")).toBe(false);
    });

    it("supports wildcard host segments", () => {
      expect(originMatchesPattern("http://192.168.1.105:3000", "http://192.168.*.*:*")).toBe(true);
      expect(originMatchesPattern("http://192.168.1.105:5173", "http://192.168.*.*:*")).toBe(true);
      expect(originMatchesPattern("http://10.0.0.5:3000", "http://10.*.*.*:*")).toBe(true);
    });

    it("rejects non-matching wildcard candidates", () => {
      // 8.8.8.8 is a public IP and must not slip through the LAN pattern.
      expect(originMatchesPattern("http://8.8.8.8:3000", "http://192.168.*.*:*")).toBe(false);
      // https:// against an http:// pattern should not match.
      expect(originMatchesPattern("https://192.168.1.5:3000", "http://192.168.*.*:*")).toBe(false);
    });

    it("does not allow patterns to match unrelated origins via leading characters", () => {
      // The pattern is anchored — `http://evil.com/192.168.1.5:3000` must not slip past.
      expect(originMatchesPattern("http://evil.com", "http://192.168.*.*:*")).toBe(false);
    });
  });

  describe("isOriginAllowed", () => {
    const patterns = ["https://app.example.com", "http://192.168.*.*:*"];

    it("returns true when at least one pattern matches", () => {
      expect(isOriginAllowed("https://app.example.com", patterns)).toBe(true);
      expect(isOriginAllowed("http://192.168.1.105:3000", patterns)).toBe(true);
    });

    it("returns false when no pattern matches", () => {
      expect(isOriginAllowed("https://evil.com", patterns)).toBe(false);
      expect(isOriginAllowed("http://10.0.0.1:3000", patterns)).toBe(false);
    });

    it("returns false for an empty pattern list", () => {
      expect(isOriginAllowed("https://example.com", [])).toBe(false);
    });
  });
});
