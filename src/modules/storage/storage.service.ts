import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";
import { STORAGE_S3_CLIENT, STORAGE_SETTINGS, type StorageSettings } from "./storage.client";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings,
  ) {}

  async uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: IMMUTABLE_CACHE_CONTROL,
      }),
    );

    return `${this.settings.publicObjectUrlPrefix}/${key}`;
  }

  async deleteObjectByKey(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.settings.bucketName,
        Key: key,
      }),
    );
  }
}
