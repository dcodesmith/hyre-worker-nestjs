import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";
import { STORAGE_S3_CLIENT, STORAGE_SETTINGS, type StorageSettings } from "./storage.client";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PRIVATE_OBJECT_KEY_MARKER = "/documents/";
const WEBP_CONTENT_TYPE = "image/webp";
export const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_PUBLIC_IMAGE_DIMENSION = 2560;

export type StoredObjectStream = {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
};

export type StoredObject = {
  key: string;
  url: string;
};

export type PreparedStorageObject = {
  buffer: Buffer;
  key: string;
  contentType: string;
  cacheControl?: string;
};

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

  const image = sharp(buffer, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  const encoded = isPrivate
    ? image.webp({ lossless: true })
    : image
        .resize({
          width: MAX_PUBLIC_IMAGE_DIMENSION,
          height: MAX_PUBLIC_IMAGE_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 85 });

  return {
    buffer: await encoded.toBuffer(),
    key: `${key.replace(/\.[^./]+$/, "")}.webp`,
    contentType: WEBP_CONTENT_TYPE,
    ...(isPrivate ? {} : { cacheControl: IMMUTABLE_CACHE_CONTROL }),
  };
}

@Injectable()
export class StorageService {
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

  async deleteObjectByKey(key: string): Promise<void> {
    if (this.settings.writePrefix && !key.startsWith(`${this.settings.writePrefix}/`)) {
      throw new Error("Refusing to delete an object outside the configured storage write prefix");
    }

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketForKey(key),
        Key: key,
      }),
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
