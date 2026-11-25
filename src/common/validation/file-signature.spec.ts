import { describe, expect, it } from "vitest";
import { hasValidFileSignature } from "./file-signature";

describe("hasValidFileSignature", () => {
  it("accepts valid JPEG, PNG, WebP, and PDF magic bytes", () => {
    expect(hasValidFileSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true);
    expect(
      hasValidFileSignature(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), "image/png"),
    ).toBe(true);
    expect(hasValidFileSignature(Buffer.from("RIFF1234WEBPdata"), "image/webp")).toBe(true);
    expect(hasValidFileSignature(Buffer.from("%PDF-1.7\n"), "application/pdf")).toBe(true);
  });

  it("rejects mismatched, truncated, empty, or unsupported payloads", () => {
    expect(hasValidFileSignature(Buffer.from("<svg></svg>"), "image/jpeg")).toBe(false);
    expect(hasValidFileSignature(Buffer.from("%PDF-1.7"), "image/png")).toBe(false);
    expect(hasValidFileSignature(Buffer.from("RIFF1234"), "image/webp")).toBe(false);
    expect(hasValidFileSignature(Buffer.alloc(0), "application/pdf")).toBe(false);
    expect(hasValidFileSignature(undefined, "application/pdf")).toBe(false);
    expect(hasValidFileSignature(Buffer.from("hello"), "text/html")).toBe(false);
  });

  it("rejects high-bit byte substitutions that decode to ASCII magic prefixes", () => {
    expect(
      hasValidFileSignature(Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]), "application/pdf"),
    ).toBe(false);
    expect(
      hasValidFileSignature(
        Buffer.from([0xd2, 0xc9, 0xc6, 0xc6, 0x00, 0x00, 0x00, 0x00, 0xd7, 0xc5, 0xc2, 0xd0]),
        "image/webp",
      ),
    ).toBe(false);
  });
});
