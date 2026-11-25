import type { PipeTransform } from "@nestjs/common";
import { hasValidFileSignature } from "../../common/validation/file-signature";
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
      !hasValidFileSignature(file.buffer, file.mimetype)
    ) {
      throw new ChauffeurBiometricNotVerifiedException();
    }
    return file;
  }
}
