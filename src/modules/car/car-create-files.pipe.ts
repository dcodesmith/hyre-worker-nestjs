import {
  IMAGE_MIME_TYPES_SET,
  MAX_FILE_SIZE_BYTES,
  MAX_IMAGE_COUNT,
  PDF_MIME_TYPE,
} from "./car.const";
import { CarValidationException } from "./car.error";
import type { UploadedCarFile } from "./car.interface";

export function validateCarImages(images: UploadedCarFile[]): void {
  if (images.length === 0) {
    throw new CarValidationException("At least one image is required");
  }
  if (images.length > MAX_IMAGE_COUNT) {
    throw new CarValidationException(`You can upload up to ${MAX_IMAGE_COUNT} images`);
  }

  for (const image of images) {
    if (!IMAGE_MIME_TYPES_SET.has(image.mimetype)) {
      throw new CarValidationException("Images must be JPEG, PNG or WebP");
    }
    if (image.size > MAX_FILE_SIZE_BYTES) {
      throw new CarValidationException("Each image must be less than 5MB");
    }
  }
}

export function validateCarCertificate(
  file: UploadedCarFile | undefined,
  label: string,
): asserts file is UploadedCarFile {
  if (!file) {
    throw new CarValidationException(`${label} certificate is required`);
  }
  if (file.mimetype !== PDF_MIME_TYPE) {
    throw new CarValidationException(`${label} certificate must be a PDF file`);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new CarValidationException(`${label} certificate must be less than 5MB`);
  }
}
