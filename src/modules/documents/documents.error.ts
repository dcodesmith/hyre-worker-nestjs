import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const DocumentsErrorCode = {
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  DOCUMENT_FILE_NOT_FOUND: "DOCUMENT_FILE_NOT_FOUND",
  DOCUMENT_FILE_FETCH_FAILED: "DOCUMENT_FILE_FETCH_FAILED",
} as const;

export class DocumentsException extends AppException {}

export class DocumentNotFoundException extends DocumentsException {
  constructor() {
    super(DocumentsErrorCode.DOCUMENT_NOT_FOUND, "Document not found", HttpStatus.NOT_FOUND, {
      type: DocumentsErrorCode.DOCUMENT_NOT_FOUND,
      title: "Document Not Found",
    });
  }
}

export class DocumentFileNotFoundException extends DocumentsException {
  constructor() {
    super(
      DocumentsErrorCode.DOCUMENT_FILE_NOT_FOUND,
      "Document file not found",
      HttpStatus.NOT_FOUND,
      {
        type: DocumentsErrorCode.DOCUMENT_FILE_NOT_FOUND,
        title: "Document File Not Found",
      },
    );
  }
}

export class DocumentFileFetchFailedException extends DocumentsException {
  constructor() {
    super(
      DocumentsErrorCode.DOCUMENT_FILE_FETCH_FAILED,
      "Failed to fetch document file",
      HttpStatus.BAD_GATEWAY,
      {
        type: DocumentsErrorCode.DOCUMENT_FILE_FETCH_FAILED,
        title: "Document File Fetch Failed",
      },
    );
  }
}
