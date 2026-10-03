import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const StorageErrorCode = {
  PUBLIC_IMAGE_ORIGIN_INVALID: "STORAGE_PUBLIC_IMAGE_ORIGIN_INVALID",
  JPEG_CONVERSION_CAPACITY_EXCEEDED: "STORAGE_JPEG_CONVERSION_CAPACITY_EXCEEDED",
  OBJECT_BODY_MISSING: "STORAGE_OBJECT_BODY_MISSING",
} as const;

export class StorageException extends AppException {}

export class StoragePublicImageOriginInvalidException extends StorageException {
  constructor() {
    super(
      StorageErrorCode.PUBLIC_IMAGE_ORIGIN_INVALID,
      "Refusing to convert an image outside the configured public storage origin",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Public Image Origin Invalid" },
    );
  }
}

export class StorageJpegConversionCapacityExceededException extends StorageException {
  constructor(maxConcurrentConversions: number) {
    super(
      StorageErrorCode.JPEG_CONVERSION_CAPACITY_EXCEEDED,
      "JPEG conversion capacity exceeded",
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        title: "JPEG Conversion Capacity Exceeded",
        details: { maxConcurrentConversions },
      },
    );
  }
}

export class StorageObjectBodyMissingException extends StorageException {
  constructor(objectType: "object" | "public image") {
    super(
      StorageErrorCode.OBJECT_BODY_MISSING,
      objectType === "public image" ? "Public image has no body" : "Storage object has no body",
      HttpStatus.BAD_GATEWAY,
      {
        title: "Storage Object Body Missing",
        details: { objectType },
      },
    );
  }
}
