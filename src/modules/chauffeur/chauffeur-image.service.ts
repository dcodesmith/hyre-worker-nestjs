import { Injectable } from "@nestjs/common";
import sharp from "sharp";
import type { UploadedChauffeurSelfie } from "./chauffeur.dto";
import { ChauffeurBiometricNotVerifiedException } from "./chauffeur.error";

@Injectable()
export class ChauffeurImageService {
  async processSelfie(file: UploadedChauffeurSelfie): Promise<Buffer> {
    try {
      return await sharp(file.buffer, { failOn: "error", limitInputPixels: 20_000_000 })
        .rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw new ChauffeurBiometricNotVerifiedException();
    }
  }
}
