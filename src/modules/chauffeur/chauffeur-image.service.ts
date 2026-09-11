import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import sharp from "sharp";
import { toLogError } from "../../common/logging/error-logging.helper";
import type { UploadedChauffeurSelfie } from "./chauffeur.dto";
import { ChauffeurInvalidSelfieException } from "./chauffeur.error";

@Injectable()
export class ChauffeurImageService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ChauffeurImageService.name);
  }

  async processSelfie(file: UploadedChauffeurSelfie): Promise<Buffer> {
    try {
      return await sharp(file.buffer, { failOn: "error", limitInputPixels: 20_000_000 })
        .rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (error) {
      this.logger.warn({ err: toLogError(error) }, "Failed to process chauffeur selfie");
      throw new ChauffeurInvalidSelfieException();
    }
  }
}
