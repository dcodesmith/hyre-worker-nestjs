import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "../../config/env.config";
import { StorageService } from "./storage.service";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const s3Config = {
  STORAGE_DRIVER: "s3",
  AWS_REGION: "eu-west-2",
  AWS_ACCESS_KEY_ID: "aws-access-key",
  AWS_SECRET_ACCESS_KEY: "aws-secret-key",
  AWS_BUCKET_NAME: "s3-car-rentals-dev-bucket",
} as const;

const r2Config = {
  STORAGE_DRIVER: "r2",
  R2_ACCOUNT_ID: "ea5151b6637ce5379c9fea75e7e52aaa",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_SECRET_ACCESS_KEY: "r2-secret-key",
  R2_IMAGES_BUCKET_NAME: "hyre-assets-images-development",
  ASSET_PUBLIC_BASE_URL: "https://images-dev.tripdly.com/",
} as const;

async function createService(config: Record<string, string>): Promise<StorageService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      StorageService,
      {
        provide: ConfigService,
        useValue: {
          get: vi.fn((key: keyof EnvConfig) => config[key]),
        },
      },
    ],
  }).compile();

  return module.get(StorageService);
}

describe("StorageService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockResolvedValue({});
  });

  describe("s3 driver", () => {
    it("uploads to the AWS bucket and returns a virtual-hosted S3 URL", async () => {
      const service = await createService(s3Config);
      const buffer = Buffer.from("image-bytes");

      const url = await service.uploadBuffer(buffer, "owner/car/images/file.jpg", "image/jpeg");

      expect(S3Client).toHaveBeenCalledWith({
        region: "eu-west-2",
        credentials: {
          accessKeyId: "aws-access-key",
          secretAccessKey: "aws-secret-key",
        },
      });
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "s3-car-rentals-dev-bucket",
        Key: "owner/car/images/file.jpg",
        Body: buffer,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      });
      expect(url).toBe(
        "https://s3-car-rentals-dev-bucket.s3.eu-west-2.amazonaws.com/owner/car/images/file.jpg",
      );
    });

    it("deletes from the AWS bucket", async () => {
      const service = await createService(s3Config);

      await service.deleteObjectByKey("owner/car/images/file.jpg");

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: "s3-car-rentals-dev-bucket",
        Key: "owner/car/images/file.jpg",
      });
    });
  });

  describe("r2 driver", () => {
    it("points the S3 client at the account endpoint and returns the public asset URL", async () => {
      const service = await createService(r2Config);
      const buffer = Buffer.from("image-bytes");

      const url = await service.uploadBuffer(buffer, "owner/car/images/file.jpg", "image/jpeg");

      expect(S3Client).toHaveBeenCalledWith({
        region: "auto",
        endpoint: "https://ea5151b6637ce5379c9fea75e7e52aaa.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: "r2-access-key",
          secretAccessKey: "r2-secret-key",
        },
      });
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "hyre-assets-images-development",
        Key: "owner/car/images/file.jpg",
        Body: buffer,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      });
      expect(url).toBe("https://images-dev.tripdly.com/owner/car/images/file.jpg");
    });

    it("deletes from the R2 images bucket", async () => {
      const service = await createService(r2Config);

      await service.deleteObjectByKey("owner/car/images/file.jpg");

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: "hyre-assets-images-development",
        Key: "owner/car/images/file.jpg",
      });
    });
  });
});
