import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "../../config/env.config";
import {
  resolveStorageSettings,
  STORAGE_S3_CLIENT,
  STORAGE_SETTINGS,
  type StorageSettings,
} from "./storage.client";
import { MAX_IMAGE_PIXELS, prepareStorageObject, StorageService } from "./storage.service";

function isWebp(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function solidImage(format: "jpeg" | "png", background: { r: number; g: number; b: number }) {
  return sharp({
    create: { width: 2, height: 2, channels: 3, background },
  })
    [format]()
    .toBuffer();
}

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
    expect(settings.writePrefix).toBeUndefined();
    expect(settings.clientConfig).toEqual({
      region: "auto",
      endpoint: "https://ea5151b6637ce5379c9fea75e7e52aaa.r2.cloudflarestorage.com",
      credentials: {
        accessKeyId: "r2-access-key",
        secretAccessKey: "r2-secret-key",
      },
    });
  });

  it("forwards a preview write prefix from R2 settings", () => {
    const settings = resolveStorageSettings(
      mockConfigService({ ...r2Env, STORAGE_WRITE_PREFIX: "previews/pr-12" }),
    );

    expect(settings.writePrefix).toBe("previews/pr-12");
  });
});

describe("StorageService", () => {
  let service: StorageService;
  let send: ReturnType<typeof vi.fn>;
  const settings: StorageSettings = {
    clientConfig: { region: "auto" },
    bucketName: "hyre-assets-images-development",
    docsBucketName: "hyre-assets-docs-development",
    publicObjectUrlPrefix: "https://images-dev.tripdly.com",
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

  it.each([["JPEG", "file.jpg", "image/jpeg"] as const, ["PNG", "file.png", "image/png"] as const])(
    "converts public %s uploads to WebP and returns the canonical key/url",
    async (_label, fileName, contentType) => {
      const buffer = await solidImage(contentType === "image/jpeg" ? "jpeg" : "png", {
        r: 255,
        g: 0,
        b: 0,
      });

      const stored = await service.uploadBuffer(
        buffer,
        `owner/car/images/${fileName}`,
        contentType,
      );

      const put = send.mock.calls[0][0].input;
      expect(put.Bucket).toBe("hyre-assets-images-development");
      expect(put.Key).toBe("owner/car/images/file.webp");
      expect(put.ContentType).toBe("image/webp");
      expect(put.CacheControl).toBe("public, max-age=31536000, immutable");
      expect(isWebp(put.Body)).toBe(true);
      expect(put.Body.equals(buffer)).toBe(false);
      await expect(sharp(put.Body).metadata()).resolves.toMatchObject({ format: "webp" });
      expect(stored).toEqual({
        key: "owner/car/images/file.webp",
        url: "https://images-dev.tripdly.com/owner/car/images/file.webp",
      });
    },
  );

  it("encodes private document images as lossless WebP and returns the object key", async () => {
    const buffer = await solidImage("png", { r: 12, g: 34, b: 56 });

    const stored = await service.uploadBuffer(buffer, "owner/car/documents/scan.png", "image/png");

    const put = send.mock.calls[0][0].input;
    expect(put.Bucket).toBe("hyre-assets-docs-development");
    expect(put.Key).toBe("owner/car/documents/scan.webp");
    expect(put.ContentType).toBe("image/webp");
    expect(put.CacheControl).toBeUndefined();
    expect(isWebp(put.Body)).toBe(true);

    const [sourcePixels, storedPixels] = await Promise.all([
      sharp(buffer).raw().toBuffer(),
      sharp(put.Body).raw().toBuffer(),
    ]);
    expect(storedPixels.equals(sourcePixels)).toBe(true);
    expect(stored).toEqual({
      key: "owner/car/documents/scan.webp",
      url: "owner/car/documents/scan.webp",
    });
  });

  it("deletes from the injected bucket", async () => {
    await service.deleteObjectByKey("owner/car/images/file.jpg");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "hyre-assets-images-development",
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
    expect(stored).toEqual({ key, url: key });
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

describe("prepareStorageObject", () => {
  it("resizes public rasters to 2560 and encodes lossy WebP", async () => {
    const buffer = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();

    const prepared = await prepareStorageObject(buffer, "owner/car/images/hero.jpg", "image/jpeg");
    const metadata = await sharp(prepared.buffer).metadata();

    expect(prepared).toMatchObject({
      key: "owner/car/images/hero.webp",
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(isWebp(prepared.buffer)).toBe(true);
    expect(["VP8 ", "VP8X"]).toContain(prepared.buffer.subarray(12, 16).toString("ascii"));
    expect(metadata.width).toBe(2560);
    expect(metadata.height).toBe(1707);
  });

  it("keeps private document rasters lossless and full size", async () => {
    const buffer = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 40, g: 50, b: 60 } },
    })
      .png()
      .toBuffer();

    const prepared = await prepareStorageObject(
      buffer,
      "owner/car/documents/scan.png",
      "image/png",
    );
    const metadata = await sharp(prepared.buffer).metadata();

    expect(prepared).toMatchObject({
      key: "owner/car/documents/scan.webp",
      contentType: "image/webp",
    });
    expect(prepared.cacheControl).toBeUndefined();
    expect(prepared.buffer.subarray(12, 16).toString("ascii")).toBe("VP8L");
    expect(metadata).toMatchObject({ width: 3000, height: 2000, format: "webp" });
  });

  it("applies EXIF rotation before encoding", async () => {
    const buffer = await sharp({
      create: { width: 2, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const prepared = await prepareStorageObject(
      buffer,
      "owner/car/images/rotated.jpg",
      "image/jpeg",
    );

    await expect(sharp(prepared.buffer).metadata()).resolves.toMatchObject({
      width: 4,
      height: 2,
    });
  });

  it("rejects images over the 25M input pixel cap", async () => {
    const width = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
    const buffer = await sharp({
      create: { width, height: width, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg({ quality: 40 })
      .toBuffer();

    await expect(
      prepareStorageObject(buffer, "owner/car/images/huge.jpg", "image/jpeg"),
    ).rejects.toThrow(/pixel limit/i);
  });

  it("leaves PDFs unchanged", async () => {
    const buffer = Buffer.from("%PDF-1.4 test");

    await expect(
      prepareStorageObject(buffer, "owner/car/documents/file.pdf", "application/pdf"),
    ).resolves.toEqual({
      buffer,
      key: "owner/car/documents/file.pdf",
      contentType: "application/pdf",
    });
  });
});

describe("StorageService write prefix", () => {
  const writePrefix = "previews/pr-12";
  const prefixedSettings: StorageSettings = {
    clientConfig: { region: "auto" },
    bucketName: "hyre-assets-images-development",
    docsBucketName: "hyre-assets-docs-development",
    publicObjectUrlPrefix: "https://images-dev.tripdly.com",
    writePrefix,
  };

  async function createPrefixedService() {
    const send = vi.fn().mockResolvedValue({});
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: STORAGE_S3_CLIENT, useValue: { send } },
        { provide: STORAGE_SETTINGS, useValue: prefixedSettings },
      ],
    }).compile();
    return { send, service: module.get(StorageService) };
  }

  it("prefixes writes and public URLs exactly once", async () => {
    const { send, service } = await createPrefixedService();
    const buffer = await solidImage("jpeg", { r: 1, g: 2, b: 3 });

    const stored = await service.uploadBuffer(buffer, "/owner/car/images/file.jpg", "image/jpeg");

    const put = send.mock.calls[0][0].input;
    expect(put.Key).toBe("previews/pr-12/owner/car/images/file.webp");
    expect(put.Key.startsWith(`${writePrefix}/${writePrefix}/`)).toBe(false);
    expect(stored).toEqual({
      key: "previews/pr-12/owner/car/images/file.webp",
      url: "https://images-dev.tripdly.com/previews/pr-12/owner/car/images/file.webp",
    });
  });

  it("prefixes private document keys exactly once", async () => {
    const { send, service } = await createPrefixedService();
    const buffer = await solidImage("png", { r: 4, g: 5, b: 6 });

    const stored = await service.uploadBuffer(buffer, "owner/car/documents/scan.png", "image/png");

    expect(send.mock.calls[0][0].input.Key).toBe("previews/pr-12/owner/car/documents/scan.webp");
    expect(stored).toEqual({
      key: "previews/pr-12/owner/car/documents/scan.webp",
      url: "previews/pr-12/owner/car/documents/scan.webp",
    });
  });

  it("reads cloned unprefixed development keys without rewriting them", async () => {
    const { send, service } = await createPrefixedService();
    const stream = { pipe: vi.fn() };
    send.mockResolvedValueOnce({ Body: stream, ContentType: "application/pdf" });

    await service.getObjectStream("owner/car/documents/cloned.pdf");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "hyre-assets-docs-development",
      Key: "owner/car/documents/cloned.pdf",
    });
  });

  it("reads exact-prefix keys as stored", async () => {
    const { send, service } = await createPrefixedService();
    send.mockResolvedValueOnce({ Body: { pipe: vi.fn() }, ContentType: "image/webp" });

    await service.getObjectStream("previews/pr-12/owner/car/documents/scan.webp");

    expect(send.mock.calls[0][0].input.Key).toBe("previews/pr-12/owner/car/documents/scan.webp");
  });

  it("refuses to delete unprefixed or sibling-prefix keys", async () => {
    const { send, service } = await createPrefixedService();

    await expect(service.deleteObjectByKey("owner/car/images/file.webp")).rejects.toThrow(
      "Refusing to delete an object outside the configured storage write prefix",
    );
    await expect(
      service.deleteObjectByKey("previews/pr-120/owner/car/images/file.webp"),
    ).rejects.toThrow("Refusing to delete an object outside the configured storage write prefix");
    expect(send).not.toHaveBeenCalled();
  });

  it("deletes exact-prefix keys", async () => {
    const { send, service } = await createPrefixedService();

    await service.deleteObjectByKey("previews/pr-12/owner/car/images/file.webp");

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "hyre-assets-images-development",
      Key: "previews/pr-12/owner/car/images/file.webp",
    });
  });
});
