import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";

@Injectable()
export class StorageService {
  private readonly bucketName: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly s3Client: S3Client;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    this.bucketName = this.configService.get("AWS_BUCKET_NAME", { infer: true });
    this.region = this.configService.get("AWS_REGION", { infer: true });
    this.accessKeyId = this.configService.get("AWS_ACCESS_KEY_ID", { infer: true });
    this.secretAccessKey = this.configService.get("AWS_SECRET_ACCESS_KEY", { infer: true });
    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });
  }

  async uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async deleteObjectByKey(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }
}
