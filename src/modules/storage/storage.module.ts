import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";
import {
  createStorageS3Client,
  resolveStorageSettings,
  STORAGE_S3_CLIENT,
  STORAGE_SETTINGS,
} from "./storage.client";
import { StorageService } from "./storage.service";

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_SETTINGS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) =>
        resolveStorageSettings(configService),
    },
    {
      provide: STORAGE_S3_CLIENT,
      inject: [STORAGE_SETTINGS],
      useFactory: createStorageS3Client,
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
