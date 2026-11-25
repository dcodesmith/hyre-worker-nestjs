import { describe, expect, it } from "vitest";
import { CarValidationException } from "./car.error";
import { CarDocumentsPipe } from "./car-documents.pipe";

const pdf = {
  originalname: "registration.pdf",
  mimetype: "application/pdf",
  size: 100,
  buffer: Buffer.from("%PDF-1.4\n"),
};

describe("CarDocumentsPipe", () => {
  const pipe = new CarDocumentsPipe();

  it("accepts all required vehicle documents", () => {
    expect(
      pipe.transform({
        vehicleRegistration: [pdf],
        motCertificate: [pdf],
        insuranceCertificate: [pdf],
      }),
    ).toEqual({
      vehicleRegistration: pdf,
      motCertificate: pdf,
      insuranceCertificate: pdf,
    });
  });

  it("rejects a request missing a required document", () => {
    expect(() =>
      pipe.transform({
        motCertificate: [pdf],
        insuranceCertificate: [pdf],
      }),
    ).toThrow(CarValidationException);
  });

  it("rejects a spoofed non-PDF payload declaring application/pdf", () => {
    const spoofed = {
      originalname: "registration.pdf",
      mimetype: "application/pdf",
      size: 30,
      buffer: Buffer.from("<script>alert(1)</script>"),
    };

    expect(() =>
      pipe.transform({
        vehicleRegistration: [spoofed],
        motCertificate: [pdf],
        insuranceCertificate: [pdf],
      }),
    ).toThrow(CarValidationException);
  });
});
