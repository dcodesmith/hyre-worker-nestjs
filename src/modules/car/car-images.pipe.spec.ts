import { describe, expect, it } from "vitest";
import { CarValidationException } from "./car.error";
import { CarImagesPipe } from "./car-images.pipe";

const image = {
  originalname: "car.jpg",
  mimetype: "image/jpeg",
  size: 100,
  buffer: Buffer.from("image"),
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
});
