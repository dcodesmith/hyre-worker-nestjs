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
    const pushPlatform = this.toPushPlatform(platform);
    await this.databaseService.$transaction(async (tx) => {
      // Serialize concurrent registrations for the same token to avoid ownership races.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${token}))`;

      const existing = await tx.userPushToken.findUnique({
        where: { token },
        select: { userId: true, revokedAt: true },
      });

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

      await tx.userPushToken.upsert({
        where: { token },
        create: {
          userId,
          token,
          platform: pushPlatform,
        },
        update: {
          userId,
          platform: pushPlatform,
          revokedAt: null,
        },
      });
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

  async getActiveTokensForUsers(userIds: string[]): Promise<Record<string, string[]>> {
    const uniqueUserIds = [...new Set(userIds.filter((userId) => userId.trim().length > 0))];
    if (uniqueUserIds.length === 0) {
      return {};
    }

    const records = await this.databaseService.userPushToken.findMany({
      where: {
        userId: { in: uniqueUserIds },
        revokedAt: null,
      },
      select: {
        userId: true,
        token: true,
      },
    });

    return records.reduce<Record<string, string[]>>((acc, record) => {
      if (!acc[record.userId]) {
        acc[record.userId] = [];
      }
      acc[record.userId].push(record.token);
      return acc;
    }, {});
  }

  private toPushPlatform(platform: "ios" | "android"): PushPlatform {
    return platform === "ios" ? PushPlatform.IOS : PushPlatform.ANDROID;
  }
}
