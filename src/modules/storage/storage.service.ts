import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

@Injectable()
export class StorageService {
  private readonly driver: EnvConfig["STORAGE_DRIVER"];
  private readonly bucketName: string;
  private readonly publicObjectUrlPrefix: string;
  private readonly s3Client: S3Client;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    this.driver = this.configService.get("STORAGE_DRIVER", { infer: true }) ?? "s3";

    if (this.driver === "r2") {
      const accountId = this.requireConfig("R2_ACCOUNT_ID");
      this.bucketName = this.requireConfig("R2_IMAGES_BUCKET_NAME");
      this.publicObjectUrlPrefix = this.normalizePublicBaseUrl(
        this.requireConfig("ASSET_PUBLIC_BASE_URL"),
      );
      this.s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.requireConfig("R2_ACCESS_KEY_ID"),
          secretAccessKey: this.requireConfig("R2_SECRET_ACCESS_KEY"),
        },
      });
      return;
    }

    const region = this.requireConfig("AWS_REGION");
    this.bucketName = this.requireConfig("AWS_BUCKET_NAME");
    this.publicObjectUrlPrefix = `https://${this.bucketName}.s3.${region}.amazonaws.com`;
    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId: this.requireConfig("AWS_ACCESS_KEY_ID"),
        secretAccessKey: this.requireConfig("AWS_SECRET_ACCESS_KEY"),
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
        CacheControl: IMMUTABLE_CACHE_CONTROL,
      }),
    );

    return `${this.publicObjectUrlPrefix}/${key}`;
  }

  async deleteObjectByKey(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }

  private requireConfig<K extends keyof EnvConfig>(key: K): NonNullable<EnvConfig[K]> {
    const value = this.configService.get(key, { infer: true });
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} is required when STORAGE_DRIVER=${this.driver}`);
    }
    return value as NonNullable<EnvConfig[K]>;
  }

  private normalizePublicBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
  }
}
