import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { ChauffeurInvalidSelfieException } from "./chauffeur.error";
import { ChauffeurImageService } from "./chauffeur-image.service";

const sharpChain = vi.hoisted(() => ({
  rotate: vi.fn().mockReturnThis(),
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: vi.fn(),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => sharpChain),
}));

describe("ChauffeurImageService", () => {
  let service: ChauffeurImageService;

  beforeEach(async () => {
    sharpChain.toBuffer.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ChauffeurImageService],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ChauffeurImageService);
  });

  it("returns the processed JPEG buffer", async () => {
    const processed = Buffer.from("processed-jpeg");
    sharpChain.toBuffer.mockResolvedValueOnce(processed);
    const file = {
      mimetype: "image/jpeg",
      size: 16,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    };

    await expect(service.processSelfie(file)).resolves.toBe(processed);
    expect(sharpChain.resize).toHaveBeenCalledWith(1024, 1024, {
      fit: "inside",
      withoutEnlargement: true,
    });
  });

  it("maps a processing failure to an invalid selfie error", async () => {
    const processingError = new Error("corrupt");
    sharpChain.toBuffer.mockRejectedValueOnce(processingError);

    await expect(
      service.processSelfie({
        mimetype: "image/jpeg",
        size: 4,
        buffer: Buffer.from("bad"),
      }),
    ).rejects.toBeInstanceOf(ChauffeurInvalidSelfieException);
  });
});
