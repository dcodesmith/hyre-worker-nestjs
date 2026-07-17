import { DocumentType } from "@prisma/client";

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 5;

/**
 * Car documents that must exist and be APPROVED before a car can be listed.
 * Owner-level docs (NIN, licence) live on the user, not the car. Mirrors what
 * car creation always uploads (see persistUploadedCarAssets).
 */
export const REQUIRED_CAR_DOCUMENT_TYPES = [
  DocumentType.MOT_CERTIFICATE,
  DocumentType.INSURANCE_CERTIFICATE,
] as const;

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const IMAGE_MIME_TYPES_SET = new Set<string>(IMAGE_MIME_TYPES);
export const PDF_MIME_TYPE = "application/pdf";

export const CAR_UPLOAD_FIELD_CONFIG = [
  { name: "images", maxCount: MAX_IMAGE_COUNT },
  { name: "motCertificate", maxCount: 1 },
  { name: "insuranceCertificate", maxCount: 1 },
] as const;

export const CAR_S3_CATEGORY_IMAGES = "images";
export const CAR_S3_CATEGORY_DOCUMENTS = "documents";

export const REJECTION_ACTION_NOTE =
  "Action required! Some of your documents/images were rejected. Please check the rejection notes and re-upload them.";
