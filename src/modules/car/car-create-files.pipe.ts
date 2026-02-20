import { Injectable, PipeTransform } from "@nestjs/common";
import {
  IMAGE_MIME_TYPES_SET,
  MAX_FILE_SIZE_BYTES,
  MAX_IMAGE_COUNT,
  PDF_MIME_TYPE,
} from "./car.const";
import { CarValidationException } from "./car.error";
import type { CarCreateFiles, CarUploadFields } from "./car.interface";

@Injectable()
export class CarCreateFilesPipe implements PipeTransform<CarUploadFields, CarCreateFiles> {
  transform(files: CarUploadFields): CarCreateFiles {
    const images = files.images ?? [];
    const motCertificate = files.motCertificate?.[0];
    const insuranceCertificate = files.insuranceCertificate?.[0];

    if (images.length === 0) {
      throw new CarValidationException("At least one image is required");
    }

    if (images.length > MAX_IMAGE_COUNT) {
      throw new CarValidationException(`You can upload up to ${MAX_IMAGE_COUNT} images`);
    }

    if (!motCertificate) {
      throw new CarValidationException("MOT certificate is required");
    }

    if (!insuranceCertificate) {
      throw new CarValidationException("Insurance certificate is required");
    }

    for (const image of images) {
      if (!IMAGE_MIME_TYPES_SET.has(image.mimetype)) {
        throw new CarValidationException("Images must be JPEG, PNG or WebP");
      }

      if (image.size > MAX_FILE_SIZE_BYTES) {
        throw new CarValidationException("Each image must be less than 5MB");
      }
    }

    if (
      motCertificate.mimetype !== PDF_MIME_TYPE ||
      insuranceCertificate.mimetype !== PDF_MIME_TYPE
    ) {
      throw new CarValidationException("MOT and insurance certificates must be PDF files");
    }
    if (
      motCertificate.size > MAX_FILE_SIZE_BYTES ||
      insuranceCertificate.size > MAX_FILE_SIZE_BYTES
    ) {
      throw new CarValidationException("Certificate files must be less than 5MB");
    }

    return {
      images,
      motCertificate,
      insuranceCertificate,
    };
  }
}
