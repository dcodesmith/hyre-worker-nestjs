import { Injectable, type PipeTransform } from "@nestjs/common";
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
};

@Injectable()
export class AccountDocumentsPipe
  implements PipeTransform<AccountDocumentUploadFields | undefined, AccountDocuments>
{
  transform(files: AccountDocumentUploadFields | undefined): AccountDocuments {
    const documents = {
      driversLicense: files?.driversLicense?.[0],
      lasdri: files?.lasdri?.[0],
    };

    this.validate(documents.driversLicense, "Driver's licence");
    this.validate(documents.lasdri, "LASDRI");
    return documents;
  }

  private validate(file: UploadedAccountDocument | undefined, label: string): void {
    if (!file) return;
    if (!ALLOWED_DOCUMENT_TYPES.has(file.mimetype)) {
      throw new AccountDocumentInvalidException(`${label} must be a JPEG, PNG, WebP, or PDF`);
    }
    if (file.size <= 0 || file.size > MAX_ACCOUNT_DOCUMENT_SIZE_BYTES) {
      throw new AccountDocumentInvalidException(`${label} must not exceed 5 MB`);
    }
    if (!this.hasExpectedSignature(file)) {
      throw new AccountDocumentInvalidException(`${label} content does not match its file type`);
    }
  }

  private hasExpectedSignature(file: UploadedAccountDocument): boolean {
    const bytes = file.buffer;
    switch (file.mimetype) {
      case "image/jpeg":
        return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      case "image/png":
        return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      case "image/webp":
        return (
          bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP"
        );
      case "application/pdf":
        return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
      default:
        return false;
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
