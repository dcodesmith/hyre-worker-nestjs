import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";
import { STORAGE_S3_CLIENT, STORAGE_SETTINGS, type StorageSettings } from "./storage.client";
import type { PreparedStorageObject, StoredObject, StoredObjectStream } from "./storage.interface";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PRIVATE_OBJECT_KEY_MARKER = "/documents/";
const WEBP_CONTENT_TYPE = "image/webp";
const WHATSAPP_JPEG_MAX_WIDTH = 1600;
const MAX_CONCURRENT_JPEG_CONVERSIONS = 3;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const WEBP_MAX_DIMENSION = 16_383;

export async function prepareStorageObject(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<PreparedStorageObject> {
  const isPrivate = key.includes(PRIVATE_OBJECT_KEY_MARKER);
  if (!contentType.startsWith("image/")) {
    return {
      buffer,
      key,
      contentType,
      ...(isPrivate ? {} : { cacheControl: IMMUTABLE_CACHE_CONTROL }),
    };
  }

  const image = sharp(buffer, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .resize({
      width: WEBP_MAX_DIMENSION,
      height: WEBP_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
  const encoded = isPrivate ? image.webp({ lossless: true }) : image.webp({ quality: 90 });

  return {
    buffer: await encoded.toBuffer(),
    key: `${key.replace(/\.[^./]+$/, "")}.webp`,
    contentType: WEBP_CONTENT_TYPE,
    ...(isPrivate ? {} : { cacheControl: IMMUTABLE_CACHE_CONTROL }),
  };
}

@Injectable()
export class StorageService {
  private readonly jpegConversions = new Map<string, Promise<string>>();

  constructor(
    @Inject(STORAGE_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings,
  ) {}

  async uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<StoredObject> {
    const writableKey = this.writableKey(key);
    const isPrivate = writableKey.includes(PRIVATE_OBJECT_KEY_MARKER);
    const object = await prepareStorageObject(buffer, writableKey, contentType);

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketForKey(object.key),
        Key: object.key,
        Body: object.buffer,
        ContentType: object.contentType,
        ...(object.cacheControl ? { CacheControl: object.cacheControl } : {}),
      }),
    );

    return {
      key: object.key,
      url: isPrivate ? object.key : `${this.settings.publicObjectUrlPrefix}/${object.key}`,
    };
  }

  async promotePrivateImage(sourceKey: string, destinationKey: string): Promise<StoredObject> {
    if (!sourceKey.includes(PRIVATE_OBJECT_KEY_MARKER)) {
      throw new Error("Only private document images can be promoted");
    }
    const key = `${this.writableKey(destinationKey).replace(/\.[^./]+$/, "")}.webp`;
    if (key.includes(PRIVATE_OBJECT_KEY_MARKER)) {
      throw new Error("Profile images must use public storage");
    }
    const copySource = [this.settings.docsBucketName, sourceKey]
      .map((part) => encodeURIComponent(part).replaceAll("%2F", "/"))
      .join("/");
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: this.settings.bucketName,
        Key: key,
        CopySource: copySource,
        ContentType: WEBP_CONTENT_TYPE,
        CacheControl: IMMUTABLE_CACHE_CONTROL,
        MetadataDirective: "REPLACE",
      }),
    );
    return { key, url: `${this.settings.publicObjectUrlPrefix}/${key}` };
  }

  async deleteObjectByKey(key: string): Promise<void> {
    if (this.settings.writePrefix && !key.startsWith(`${this.settings.writePrefix}/`)) {
      throw new Error("Refusing to delete an object outside the configured storage write prefix");
    }

    const keys =
      /(^|\/)cars\//.test(key) && key.endsWith(".webp")
        ? [key, key.replace(/\.webp$/, ".jpg")]
        : [key];
    await Promise.all(
      keys.map((objectKey) =>
        this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.bucketForKey(objectKey),
            Key: objectKey,
          }),
        ),
      ),
    );
  }

  async getObjectStream(key: string): Promise<StoredObjectStream> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.settings.docsBucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error("Storage object has no body");
    }

    return {
      stream: response.Body as Readable,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  }

  async ensurePublicJpeg(publicUrl: string): Promise<string> {
    const publicPrefix = `${this.settings.publicObjectUrlPrefix.replace(/\/$/, "")}/`;
    if (!publicUrl.startsWith(publicPrefix)) {
      throw new Error("Refusing to convert an image outside the configured public storage origin");
    }
    const sourceKey = decodeURIComponent(publicUrl.slice(publicPrefix.length));
    const writableSourceKey =
      this.settings.writePrefix && !sourceKey.startsWith(`${this.settings.writePrefix}/`)
        ? `${this.settings.writePrefix}/${sourceKey}`
        : sourceKey;
    const jpegKey = writableSourceKey.replace(/\.[^./]+$/, ".jpg");
    const jpegUrl = `${publicPrefix}${jpegKey}`;

    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.settings.bucketName,
          Key: jpegKey,
        }),
      );
      return jpegUrl;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status !== 404) {
        throw error;
      }
    }

    const activeConversion = this.jpegConversions.get(jpegKey);
    if (activeConversion) {
      return activeConversion;
    }
    if (this.jpegConversions.size >= MAX_CONCURRENT_JPEG_CONVERSIONS) {
      throw new Error("JPEG conversion capacity exceeded");
    }

    const conversion = this.convertPublicImageToJpeg(sourceKey, jpegKey, jpegUrl);
    this.jpegConversions.set(jpegKey, conversion);
    try {
      return await conversion;
    } finally {
      this.jpegConversions.delete(jpegKey);
    }
  }

  private async convertPublicImageToJpeg(
    sourceKey: string,
    jpegKey: string,
    jpegUrl: string,
  ): Promise<string> {
    const source = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.settings.bucketName,
        Key: sourceKey,
      }),
    );
    if (!source.Body) {
      throw new Error("Public image has no body");
    }

    const jpeg = await sharp(Buffer.from(await source.Body.transformToByteArray()), {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .resize({ width: WHATSAPP_JPEG_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucketName,
        Key: jpegKey,
        Body: jpeg,
        ContentType: "image/jpeg",
        CacheControl: IMMUTABLE_CACHE_CONTROL,
      }),
    );

    return jpegUrl;
  }

  private bucketForKey(key: string): string {
    return key.includes(PRIVATE_OBJECT_KEY_MARKER)
      ? this.settings.docsBucketName
      : this.settings.bucketName;
  }

  private writableKey(key: string): string {
    const normalizedKey = key.replace(/^\/+/, "");
    return this.settings.writePrefix
      ? `${this.settings.writePrefix}/${normalizedKey}`
      : normalizedKey;
  }
}
