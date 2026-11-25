import { Injectable, type PipeTransform } from "@nestjs/common";
import { hasValidFileSignature } from "../../common/validation/file-signature";
import type {
  AccountDocumentUploadFields,
  UploadedAccountDocument,
} from "./account-verification.dto";
import { AccountDocumentInvalidException } from "./account-verification.error";

export const MAX_ACCOUNT_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export type AccountDocuments = {
  driversLicense?: UploadedAccountDocument;
  lasdri?: UploadedAccountDocument;
  selfie?: UploadedAccountDocument;
};

@Injectable()
export class AccountDocumentsPipe
  implements PipeTransform<AccountDocumentUploadFields | undefined, AccountDocuments>
{
  transform(files: AccountDocumentUploadFields | undefined): AccountDocuments {
    const documents = {
      driversLicense: files?.driversLicense?.[0],
      lasdri: files?.lasdri?.[0],
      selfie: files?.selfie?.[0],
    };

    this.validate(documents.driversLicense, "Driver's licence", true);
    this.validate(documents.lasdri, "LASDRI", true);
    this.validate(documents.selfie, "Selfie", false);
    return documents;
  }

  private validate(
    file: UploadedAccountDocument | undefined,
    label: string,
    allowPdf: boolean,
  ): void {
    if (!file) return;
    if (
      !ALLOWED_DOCUMENT_TYPES.has(file.mimetype) ||
      (!allowPdf && file.mimetype === "application/pdf")
    ) {
      throw new AccountDocumentInvalidException(
        allowPdf
          ? `${label} must be a JPEG, PNG, WebP, or PDF`
          : `${label} must be a JPEG, PNG, or WebP`,
      );
    }
    if (file.size <= 0 || file.size > MAX_ACCOUNT_DOCUMENT_SIZE_BYTES) {
      throw new AccountDocumentInvalidException(`${label} must not exceed 5 MB`);
    }
    if (!hasValidFileSignature(file.buffer, file.mimetype)) {
      throw new AccountDocumentInvalidException(`${label} content does not match its file type`);
    }
  }
}

@Injectable()
export class AccountDriverLicensePipe
  implements PipeTransform<UploadedAccountDocument | undefined, UploadedAccountDocument>
{
  transform(file: UploadedAccountDocument | undefined): UploadedAccountDocument {
    if (!file) {
      throw new AccountDocumentInvalidException("A driver's licence file is required");
    }
    const documents = new AccountDocumentsPipe().transform({ driversLicense: [file] });
    return documents.driversLicense as UploadedAccountDocument;
  }
}

@Injectable()
export class AccountSelfiePipe
  implements PipeTransform<UploadedAccountDocument | undefined, UploadedAccountDocument>
{
  transform(file: UploadedAccountDocument | undefined): UploadedAccountDocument {
    if (!file) {
      throw new AccountDocumentInvalidException("A selfie is required");
    }
    const documents = new AccountDocumentsPipe().transform({ selfie: [file] });
    return documents.selfie as UploadedAccountDocument;
  }
}
