import type { PipeTransform } from "@nestjs/common";
import type { UploadedChauffeurSelfie } from "./chauffeur.dto";
import { ChauffeurBiometricNotVerifiedException } from "./chauffeur.error";

export const MAX_CHAUFFEUR_SELFIE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_SELFIE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class ChauffeurSelfiePipe
  implements PipeTransform<UploadedChauffeurSelfie | undefined, UploadedChauffeurSelfie>
{
  transform(file: UploadedChauffeurSelfie | undefined): UploadedChauffeurSelfie {
    if (
      !file ||
      !ALLOWED_SELFIE_TYPES.has(file.mimetype) ||
      file.size <= 0 ||
      file.size > MAX_CHAUFFEUR_SELFIE_SIZE_BYTES ||
      !this.hasExpectedSignature(file)
    ) {
      throw new ChauffeurBiometricNotVerifiedException();
    }
    return file;
  }

  private hasExpectedSignature(file: UploadedChauffeurSelfie): boolean {
    const bytes = file.buffer;
    if (file.mimetype === "image/jpeg") {
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (file.mimetype === "image/png") {
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
}
