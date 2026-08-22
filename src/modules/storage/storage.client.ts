import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";

export const STORAGE_S3_CLIENT = Symbol("STORAGE_S3_CLIENT");
export const STORAGE_SETTINGS = Symbol("STORAGE_SETTINGS");

export type StorageSettings = {
  clientConfig: S3ClientConfig;
  bucketName: string;
  publicObjectUrlPrefix: string;
};

export function resolveStorageSettings(configService: ConfigService<EnvConfig>): StorageSettings {
  const get = <K extends keyof EnvConfig>(key: K) =>
    configService.get(key, { infer: true }) as NonNullable<EnvConfig[K]>;
  const driver = get("STORAGE_DRIVER") ?? "s3";

  if (driver === "r2") {
    return {
      clientConfig: {
        region: "auto",
        endpoint: `https://${get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: get("R2_ACCESS_KEY_ID"),
          secretAccessKey: get("R2_SECRET_ACCESS_KEY"),
        },
      },
      bucketName: get("R2_IMAGES_BUCKET_NAME"),
      publicObjectUrlPrefix: get("ASSET_PUBLIC_BASE_URL").replace(/\/+$/, ""),
    };
  }

  const region = get("AWS_REGION");
  const bucketName = get("AWS_BUCKET_NAME");
  return {
    clientConfig: {
      region,
      credentials: {
        accessKeyId: get("AWS_ACCESS_KEY_ID"),
        secretAccessKey: get("AWS_SECRET_ACCESS_KEY"),
      },
    },
    bucketName,
    publicObjectUrlPrefix: `https://${bucketName}.s3.${region}.amazonaws.com`,
  };
}

export function createStorageS3Client(settings: StorageSettings): S3Client {
  return new S3Client(settings.clientConfig);
}
