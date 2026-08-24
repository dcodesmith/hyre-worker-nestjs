import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";
import { STORAGE_S3_CLIENT, STORAGE_SETTINGS, type StorageSettings } from "./storage.client";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PRIVATE_OBJECT_KEY_MARKER = "/documents/";

export type StoredObjectStream = {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
};

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings,
  ) {}

  async uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
    const isPrivate = key.includes(PRIVATE_OBJECT_KEY_MARKER);
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketForKey(key),
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ...(isPrivate ? {} : { CacheControl: IMMUTABLE_CACHE_CONTROL }),
      }),
    );

    return isPrivate ? key : `${this.settings.publicObjectUrlPrefix}/${key}`;
  }

  async deleteObjectByKey(key: string): Promise<void> {
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
}
