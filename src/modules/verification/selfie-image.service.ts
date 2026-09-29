import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import sharp from "sharp";
import { toLogError } from "../../common/logging/error-logging.helper";

export class InvalidSelfieImageError extends Error {}

@Injectable()
export class SelfieImageService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(SelfieImageService.name);
  }

  async process(file: { buffer: Buffer }): Promise<Buffer> {
    try {
      return await sharp(file.buffer, { failOn: "error", limitInputPixels: 20_000_000 })
        .rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (error) {
      this.logger.warn({ err: toLogError(error) }, "Failed to process driver selfie");
      throw new InvalidSelfieImageError();
    }
  }
}
