import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const DocumentsErrorCode = {
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  DOCUMENT_FILE_NOT_FOUND: "DOCUMENT_FILE_NOT_FOUND",
  DOCUMENT_FILE_FETCH_FAILED: "DOCUMENT_FILE_FETCH_FAILED",
  DOCUMENT_APPROVAL_FAILED: "DOCUMENT_APPROVAL_FAILED",
} as const;

export class DocumentsException extends AppException {}

export class DocumentNotFoundException extends DocumentsException {
  constructor() {
    super(DocumentsErrorCode.DOCUMENT_NOT_FOUND, "Document not found", HttpStatus.NOT_FOUND, {
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
        title: "Document File Fetch Failed",
      },
    );
  }
}

export class DocumentApprovalFailedException extends DocumentsException {
  constructor() {
    super(
      DocumentsErrorCode.DOCUMENT_APPROVAL_FAILED,
      "An unexpected error occurred while processing the approval action",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Document Approval Failed" },
    );
  }
}
