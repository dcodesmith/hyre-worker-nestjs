import { describe, expect, it } from "vitest";
import { CarValidationException } from "./car.error";
import { CarDocumentsPipe } from "./car-documents.pipe";

const pdf = {
  originalname: "registration.pdf",
  mimetype: "application/pdf",
  size: 100,
  buffer: Buffer.from("pdf"),
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
});
