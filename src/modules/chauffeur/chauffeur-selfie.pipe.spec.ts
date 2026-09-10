import { describe, expect, it } from "vitest";
import { ChauffeurBiometricNotVerifiedException } from "./chauffeur.error";
import { ChauffeurSelfiePipe, MAX_CHAUFFEUR_SELFIE_SIZE_BYTES } from "./chauffeur-selfie.pipe";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

describe("ChauffeurSelfiePipe", () => {
  const pipe = new ChauffeurSelfiePipe();

  it("accepts JPEG, PNG, and WebP files with matching magic bytes", () => {
    expect(
      pipe.transform({
        mimetype: "image/jpeg",
        size: jpeg.length,
        buffer: jpeg,
      }),
    ).toMatchObject({ mimetype: "image/jpeg" });
    expect(
      pipe.transform({
        mimetype: "image/png",
        size: png.length,
        buffer: png,
      }),
    ).toMatchObject({ mimetype: "image/png" });
    expect(
      pipe.transform({
        mimetype: "image/webp",
        size: webp.length,
        buffer: webp,
      }),
    ).toMatchObject({ mimetype: "image/webp" });
  });

  it("rejects a missing file, wrong type, empty file, oversized file, or spoofed bytes", () => {
    expect(() => pipe.transform(undefined)).toThrow(ChauffeurBiometricNotVerifiedException);
    expect(() =>
      pipe.transform({
        mimetype: "image/gif",
        size: jpeg.length,
        buffer: jpeg,
      }),
    ).toThrow(ChauffeurBiometricNotVerifiedException);
    expect(() =>
      pipe.transform({
        mimetype: "image/jpeg",
        size: 0,
        buffer: jpeg,
      }),
    ).toThrow(ChauffeurBiometricNotVerifiedException);
    expect(() =>
      pipe.transform({
        mimetype: "image/jpeg",
        size: MAX_CHAUFFEUR_SELFIE_SIZE_BYTES + 1,
        buffer: jpeg,
      }),
    ).toThrow(ChauffeurBiometricNotVerifiedException);
    expect(() =>
      pipe.transform({
        mimetype: "image/jpeg",
        size: 4,
        buffer: Buffer.from("notj"),
      }),
    ).toThrow(ChauffeurBiometricNotVerifiedException);
  });
});
