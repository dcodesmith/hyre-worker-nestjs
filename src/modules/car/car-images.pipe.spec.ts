import { describe, expect, it } from "vitest";
import { CarValidationException } from "./car.error";
import { CarImagesPipe } from "./car-images.pipe";
import { CarReplaceFilePipe } from "./car-replace-file.pipe";

const image = {
  originalname: "car.jpg",
  mimetype: "image/jpeg",
  size: 100,
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
};

describe("CarImagesPipe", () => {
  const pipe = new CarImagesPipe();

  it("accepts at least three images", () => {
    const images = [image, image, image];
    expect(pipe.transform(images)).toBe(images);
  });

  it("rejects fewer than three images", () => {
    expect(() => pipe.transform([image, image])).toThrow(CarValidationException);
  });

  it("rejects images whose magic bytes do not match their declared MIME type", () => {
    const spoofed = {
      originalname: "car.jpg",
      mimetype: "image/jpeg",
      size: 25,
      buffer: Buffer.from("<html>not a jpeg</html>"),
    };

    expect(() => pipe.transform([image, image, spoofed])).toThrow(CarValidationException);
  });
});

describe("CarReplaceFilePipe", () => {
  it("rejects spoofed image and document payloads", () => {
    const imagePipe = new CarReplaceFilePipe("image");
    const docPipe = new CarReplaceFilePipe("document");

    expect(() =>
      imagePipe.transform({
        originalname: "fake.png",
        mimetype: "image/png",
        size: 16,
        buffer: Buffer.from("not-a-png"),
      }),
    ).toThrow(CarValidationException);

    expect(() =>
      docPipe.transform({
        originalname: "fake.pdf",
        mimetype: "application/pdf",
        size: 16,
        buffer: Buffer.from("not-a-pdf"),
      }),
    ).toThrow(CarValidationException);

    expect(imagePipe.transform(image)).toBe(image);
  });
});
