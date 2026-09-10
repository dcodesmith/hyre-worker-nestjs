import { describe, expect, it } from "vitest";
import { AccountDocumentsPipe } from "./account-documents.pipe";
import type { UploadedAccountDocument } from "./account-verification.dto";
import { AccountDocumentInvalidException } from "./account-verification.error";

const pipe = new AccountDocumentsPipe();

const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const webpBytes = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0x00, 0x00]),
]);
const pdfBytes = Buffer.from("%PDF-1.4 licence");

function file(overrides: Partial<UploadedAccountDocument> = {}): UploadedAccountDocument {
  return {
    originalname: "license.pdf",
    mimetype: "application/pdf",
    size: pdfBytes.length,
    buffer: pdfBytes,
    ...overrides,
  };
}

describe("AccountDocumentsPipe", () => {
  it("returns empty documents when no files are uploaded", () => {
    expect(pipe.transform(undefined)).toEqual({
      driversLicense: undefined,
      lasdri: undefined,
    });
  });

  it("takes the first file from each field", () => {
    const driversLicense = file({ originalname: "front.pdf" });
    const lasdri = file({
      originalname: "lasdri.jpg",
      mimetype: "image/jpeg",
      size: jpegBytes.length,
      buffer: jpegBytes,
    });

    expect(
      pipe.transform({
        driversLicense: [driversLicense, file({ originalname: "ignored.pdf" })],
        lasdri: [lasdri],
      }),
    ).toEqual({ driversLicense, lasdri });
  });

  it.each([
    { mimetype: "image/jpeg" as const, buffer: jpegBytes },
    { mimetype: "image/png" as const, buffer: pngBytes },
    { mimetype: "image/webp" as const, buffer: webpBytes },
    { mimetype: "application/pdf" as const, buffer: pdfBytes },
  ])("accepts $mimetype when the content signature matches", ({ mimetype, buffer }) => {
    expect(
      pipe.transform({
        driversLicense: [file({ mimetype, size: buffer.length, buffer })],
      }).driversLicense?.mimetype,
    ).toBe(mimetype);
  });

  it("rejects an image whose MIME type is spoofed", () => {
    expect(() =>
      pipe.transform({
        driversLicense: [
          file({
            originalname: "license.jpg",
            mimetype: "image/jpeg",
            size: pdfBytes.length,
            buffer: pdfBytes,
          }),
        ],
      }),
    ).toThrow(AccountDocumentInvalidException);
  });

  it("rejects an unsupported licence type", () => {
    expect(() => pipe.transform({ driversLicense: [file({ mimetype: "image/gif" })] })).toThrow(
      AccountDocumentInvalidException,
    );
  });

  it("rejects an unsupported LASDRI type", () => {
    expect(() => pipe.transform({ lasdri: [file({ mimetype: "text/plain" })] })).toThrow(
      AccountDocumentInvalidException,
    );
  });

  it.each([0, 5 * 1024 * 1024 + 1])("rejects a licence whose size is %s bytes", (size) => {
    expect(() =>
      pipe.transform({ driversLicense: [file({ size, buffer: Buffer.concat([pdfBytes]) })] }),
    ).toThrow(AccountDocumentInvalidException);
  });

  it("accepts a 5 MB document with a valid signature", () => {
    const buffer = Buffer.alloc(5 * 1024 * 1024);
    pdfBytes.copy(buffer);
    expect(
      pipe.transform({
        lasdri: [file({ size: buffer.length, buffer })],
      }).lasdri?.size,
    ).toBe(5 * 1024 * 1024);
  });
});
