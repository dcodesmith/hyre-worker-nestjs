import { Injectable, PipeTransform } from "@nestjs/common";
import { IMAGE_MIME_TYPES_SET, MAX_FILE_SIZE_BYTES, PDF_MIME_TYPE } from "./car.const";
import { CarValidationException } from "./car.error";
import type { UploadedCarFile } from "./car.interface";

@Injectable()
export class CarImageFilePipe implements PipeTransform<UploadedCarFile | undefined> {
  transform(file: UploadedCarFile | undefined): UploadedCarFile {
    if (!file) {
      throw new CarValidationException("An image file is required");
    }
    if (!IMAGE_MIME_TYPES_SET.has(file.mimetype)) {
      throw new CarValidationException("Images must be JPEG, PNG or WebP");
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new CarValidationException("Each image must be less than 5MB");
    }
    return file;
  }
}

@Injectable()
export class CarDocumentFilePipe implements PipeTransform<UploadedCarFile | undefined> {
  transform(file: UploadedCarFile | undefined): UploadedCarFile {
    if (!file) {
      throw new CarValidationException("A document file is required");
    }
    if (file.mimetype !== PDF_MIME_TYPE) {
      throw new CarValidationException("Documents must be PDF files");
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new CarValidationException("Document files must be less than 5MB");
    }
    return file;
  }
}
