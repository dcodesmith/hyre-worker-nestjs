import { Injectable } from "@nestjs/common";
import { PushPlatform } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { PushTokenOwnershipConflictException } from "./notification.error";

@Injectable()
export class PushTokenService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PushTokenService.name);
  }

  async registerToken(userId: string, token: string, platform: "ios" | "android"): Promise<void> {
    const existing = await this.databaseService.userPushToken.findUnique({
      where: { token },
      select: { userId: true, revokedAt: true },
    });

    // Block silent ownership transfer: if the token is currently bound to a
    // different active user, reject. Re-registration is only allowed when the
    // existing record belongs to the same user, or has been revoked.
    if (existing && existing.userId !== userId && existing.revokedAt === null) {
      this.logger.warn(
        {
          requestingUserId: userId,
          ownerUserId: existing.userId,
        },
        "Rejected push token registration owned by a different active user",
      );
      throw new PushTokenOwnershipConflictException();
    }

    await this.databaseService.userPushToken.upsert({
      where: { token },
      update: {
        userId,
        platform: this.toPushPlatform(platform),
        revokedAt: null,
      },
      create: {
        userId,
        token,
        platform: this.toPushPlatform(platform),
      },
    });
  }

  async revokeToken(userId: string, token: string): Promise<void> {
    await this.databaseService.userPushToken.updateMany({
      where: {
        userId,
        token,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async revokeTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    const dedupedTokens = [...new Set(tokens)];
    await this.databaseService.userPushToken.updateMany({
      where: {
        token: { in: dedupedTokens },
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    this.logger.info({ tokenCount: dedupedTokens.length }, "Revoked invalid push tokens");
  }

  async getActiveTokensForUser(userId: string): Promise<string[]> {
    const records = await this.databaseService.userPushToken.findMany({
      where: {
        userId,
        revokedAt: null,
      },
      select: {
        token: true,
      },
    });

    return records.map((record) => record.token);
  }

  private toPushPlatform(platform: "ios" | "android"): PushPlatform {
    return platform === "ios" ? PushPlatform.IOS : PushPlatform.ANDROID;
  }
}
