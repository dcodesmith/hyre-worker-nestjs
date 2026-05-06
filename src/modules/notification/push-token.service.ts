import { Injectable } from "@nestjs/common";
import { Prisma, PushPlatform } from "@prisma/client";
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
    await this.databaseService.$transaction(async (tx) => {
      const pushPlatform = this.toPushPlatform(platform);

      try {
        await tx.userPushToken.create({
          data: {
            userId,
            token,
            platform: pushPlatform,
          },
        });
        return;
      } catch (error) {
        if (!this.isUniqueConstraintError(error)) {
          throw error;
        }
      }

      const updateResult = await tx.userPushToken.updateMany({
        where: {
          token,
          OR: [{ userId }, { revokedAt: { not: null } }],
        },
        data: {
          userId,
          platform: pushPlatform,
          revokedAt: null,
        },
      });

      if (updateResult.count > 0) {
        return;
      }

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

      // Defensive retry for transient row disappearance between write attempts.
      await tx.userPushToken.create({
        data: {
          userId,
          token,
          platform: pushPlatform,
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

  private toPushPlatform(platform: "ios" | "android"): PushPlatform {
    return platform === "ios" ? PushPlatform.IOS : PushPlatform.ANDROID;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
