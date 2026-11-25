import { Injectable, PipeTransform } from "@nestjs/common";
import { hasValidFileSignature } from "../../common/validation/file-signature";
import { IMAGE_MIME_TYPES_SET, MAX_FILE_SIZE_BYTES, PDF_MIME_TYPE } from "./car.const";
import { CarValidationException } from "./car.error";
import type { UploadedCarFile } from "./car.interface";

@Injectable()
export class CarReplaceFilePipe implements PipeTransform<UploadedCarFile | undefined> {
  constructor(private readonly kind: "image" | "document") {}

  transform(file: UploadedCarFile | undefined): UploadedCarFile {
    const isImage = this.kind === "image";
    if (!file) {
      throw new CarValidationException(
        isImage ? "An image file is required" : "A document file is required",
      );
    }
    if (isImage ? !IMAGE_MIME_TYPES_SET.has(file.mimetype) : file.mimetype !== PDF_MIME_TYPE) {
      throw new CarValidationException(
        isImage ? "Images must be JPEG, PNG or WebP" : "Documents must be PDF files",
      );
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE_BYTES) {
      throw new CarValidationException(
        isImage ? "Each image must be less than 5MB" : "Document files must be less than 5MB",
      );
    }
    if (!hasValidFileSignature(file.buffer, file.mimetype)) {
      throw new CarValidationException(
        isImage
          ? "Image content does not match its file type"
          : "Document content does not match its file type",
      );
    }
    return file;
  }
}
