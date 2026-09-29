import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { InvalidSelfieImageError, SelfieImageService } from "./selfie-image.service";

const sharpChain = vi.hoisted(() => ({
  rotate: vi.fn().mockReturnThis(),
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: vi.fn(),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => sharpChain),
}));

describe("SelfieImageService", () => {
  let service: SelfieImageService;

  beforeEach(async () => {
    sharpChain.toBuffer.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [SelfieImageService],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(SelfieImageService);
  });

  it("returns the processed jpeg buffer", async () => {
    const processed = Buffer.from("jpeg");
    sharpChain.toBuffer.mockResolvedValueOnce(processed);

    await expect(service.process({ buffer: Buffer.from([0xff, 0xd8]) })).resolves.toBe(processed);
  });

  it("maps a processing failure to an invalid selfie error", async () => {
    sharpChain.toBuffer.mockRejectedValueOnce(new Error("corrupt"));

    await expect(service.process({ buffer: Buffer.from("bad") })).rejects.toBeInstanceOf(
      InvalidSelfieImageError,
    );
  });
});
