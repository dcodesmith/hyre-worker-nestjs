import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "../../config/env.config";
import {
  resolveStorageSettings,
  STORAGE_S3_CLIENT,
  STORAGE_SETTINGS,
  type StorageSettings,
} from "./storage.client";
import { StorageService } from "./storage.service";

const s3Env = {
  STORAGE_DRIVER: "s3",
  AWS_REGION: "eu-west-2",
  AWS_ACCESS_KEY_ID: "aws-access-key",
  AWS_SECRET_ACCESS_KEY: "aws-secret-key",
  AWS_BUCKET_NAME: "s3-car-rentals-dev-bucket",
} as const;

const r2Env = {
  STORAGE_DRIVER: "r2",
  R2_ACCOUNT_ID: "ea5151b6637ce5379c9fea75e7e52aaa",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_SECRET_ACCESS_KEY: "r2-secret-key",
  R2_IMAGES_BUCKET_NAME: "hyre-assets-images-development",
  R2_DOCS_BUCKET_NAME: "hyre-assets-docs-development",
  ASSET_PUBLIC_BASE_URL: "https://images-dev.tripdly.com/",
} as const;

function mockConfigService(config: Record<string, string>): ConfigService<EnvConfig> {
  return {
    get: vi.fn((key: keyof EnvConfig) => config[key]),
  } as unknown as ConfigService<EnvConfig>;
}

describe("resolveStorageSettings", () => {
  it("builds AWS virtual-host settings for the s3 driver", () => {
    const settings = resolveStorageSettings(mockConfigService(s3Env));

    expect(settings.bucketName).toBe("s3-car-rentals-dev-bucket");
    expect(settings.docsBucketName).toBe("s3-car-rentals-dev-bucket");
    expect(settings.publicObjectUrlPrefix).toBe(
      "https://s3-car-rentals-dev-bucket.s3.eu-west-2.amazonaws.com",
    );
    expect(settings.clientConfig).toEqual({
      region: "eu-west-2",
      credentials: {
        accessKeyId: "aws-access-key",
        secretAccessKey: "aws-secret-key",
      },
    });
  });

  it("builds the R2 account endpoint and strips a trailing slash from the public base URL", () => {
    const settings = resolveStorageSettings(mockConfigService(r2Env));

    expect(settings.bucketName).toBe("hyre-assets-images-development");
    expect(settings.docsBucketName).toBe("hyre-assets-docs-development");
    expect(settings.publicObjectUrlPrefix).toBe("https://images-dev.tripdly.com");
    expect(settings.clientConfig).toEqual({
      region: "auto",
      endpoint: "https://ea5151b6637ce5379c9fea75e7e52aaa.r2.cloudflarestorage.com",
      credentials: {
        accessKeyId: "r2-access-key",
        secretAccessKey: "r2-secret-key",
      },
    });
  });
});

describe("StorageService", () => {
  let service: StorageService;
  let send: ReturnType<typeof vi.fn>;
  const settings: StorageSettings = {
    clientConfig: { region: "eu-west-2" },
    bucketName: "s3-car-rentals-dev-bucket",
    docsBucketName: "hyre-assets-docs-development",
    publicObjectUrlPrefix: "https://s3-car-rentals-dev-bucket.s3.eu-west-2.amazonaws.com",
  };

  beforeEach(async () => {
    send = vi.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: STORAGE_S3_CLIENT, useValue: { send } },
        { provide: STORAGE_SETTINGS, useValue: settings },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  it("uploads to the injected bucket and returns the public object URL", async () => {
    const buffer = Buffer.from("image-bytes");

    const url = await service.uploadBuffer(buffer, "owner/car/images/file.jpg", "image/jpeg");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
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

  it("deletes from the injected bucket", async () => {
    await service.deleteObjectByKey("owner/car/images/file.jpg");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "s3-car-rentals-dev-bucket",
      Key: "owner/car/images/file.jpg",
    });
  });

  it("uploads documents to the docs bucket and returns the object key", async () => {
    const buffer = Buffer.from("pdf-bytes");
    const key = "owner/car/documents/file.pdf";

    const stored = await service.uploadBuffer(buffer, key, "application/pdf");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "hyre-assets-docs-development",
      Key: key,
      Body: buffer,
      ContentType: "application/pdf",
    });
    expect(stored).toBe(key);
  });

  it("deletes documents from the docs bucket", async () => {
    await service.deleteObjectByKey("owner/car/documents/file.pdf");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "hyre-assets-docs-development",
      Key: "owner/car/documents/file.pdf",
    });
  });

  it("streams a stored document from the docs bucket", async () => {
    const stream = { pipe: vi.fn() };
    send.mockResolvedValueOnce({
      Body: stream,
      ContentType: "application/pdf",
      ContentLength: 12,
    });

    const result = await service.getObjectStream("owner/car/documents/file.pdf");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "hyre-assets-docs-development",
      Key: "owner/car/documents/file.pdf",
    });
    expect(result).toEqual({
      stream,
      contentType: "application/pdf",
      contentLength: 12,
    });
  });
});
