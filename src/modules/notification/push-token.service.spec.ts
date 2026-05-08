import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { PushTokenOwnershipConflictException } from "./notification.error";
import { PushTokenService } from "./push-token.service";

describe("PushTokenService", () => {
  let service: PushTokenService;

  const databaseServiceMock = {
    $transaction: vi.fn(),
    userPushToken: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      $executeRaw: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.$transaction.mockImplementation(async (callback) =>
      callback({
        $executeRaw: databaseServiceMock.userPushToken.$executeRaw,
        userPushToken: databaseServiceMock.userPushToken,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushTokenService,
        {
          provide: DatabaseService,
          useValue: databaseServiceMock,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<PushTokenService>(PushTokenService);
  });

  it("registers token by creating or updating through idempotent upsert", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce(null);
    databaseServiceMock.userPushToken.upsert.mockResolvedValueOnce(undefined);

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.$transaction).toHaveBeenCalledTimes(1);
    expect(databaseServiceMock.userPushToken.$executeRaw).toHaveBeenCalledTimes(1);
    expect(databaseServiceMock.userPushToken.findUnique).toHaveBeenCalledWith({
      where: { token: "ExponentPushToken[abc123]" },
      select: { userId: true, revokedAt: true },
    });
    expect(databaseServiceMock.userPushToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: "ExponentPushToken[abc123]" },
        create: expect.objectContaining({
          userId: "user-1",
          token: "ExponentPushToken[abc123]",
          platform: "IOS",
        }),
        update: expect.objectContaining({
          userId: "user-1",
          platform: "IOS",
          revokedAt: null,
        }),
      }),
    );
  });

  it("re-activates token for same owner with upsert", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce({
      userId: "user-1",
      revokedAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    databaseServiceMock.userPushToken.upsert.mockResolvedValueOnce(undefined);

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          userId: "user-1",
          platform: "IOS",
          revokedAt: null,
        }),
      }),
    );
  });

  it("allows re-registering a token previously revoked by another user", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce({
      userId: "user-2",
      revokedAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    databaseServiceMock.userPushToken.upsert.mockResolvedValueOnce(undefined);

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.upsert).toHaveBeenCalled();
  });

  it("rejects ownership transfer when token is actively owned by another user", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce({
      userId: "user-2",
      revokedAt: null,
    });

    await expect(
      service.registerToken("user-1", "ExponentPushToken[abc123]", "ios"),
    ).rejects.toBeInstanceOf(PushTokenOwnershipConflictException);
    expect(databaseServiceMock.userPushToken.upsert).not.toHaveBeenCalled();
  });

  it("revokes token for the current user", async () => {
    await service.revokeToken("user-1", "ExponentPushToken[abc123]");

    expect(databaseServiceMock.userPushToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          token: "ExponentPushToken[abc123]",
          revokedAt: null,
        }),
      }),
    );
  });

  it("revokes invalid tokens in bulk", async () => {
    await service.revokeTokens([
      "ExponentPushToken[a]",
      "ExponentPushToken[a]",
      "ExponentPushToken[b]",
    ]);

    expect(databaseServiceMock.userPushToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          token: { in: ["ExponentPushToken[a]", "ExponentPushToken[b]"] },
        }),
      }),
    );
  });

  it("returns active push tokens for a user", async () => {
    databaseServiceMock.userPushToken.findMany.mockResolvedValueOnce([
      { token: "ExponentPushToken[a]" },
      { token: "ExponentPushToken[b]" },
    ]);

    const tokens = await service.getActiveTokensForUser("user-1");

    expect(tokens).toEqual(["ExponentPushToken[a]", "ExponentPushToken[b]"]);
    expect(databaseServiceMock.userPushToken.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        revokedAt: null,
      },
      select: {
        token: true,
      },
    });
  });
});
