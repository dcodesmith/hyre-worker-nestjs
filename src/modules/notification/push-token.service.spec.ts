import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { PushTokenOwnershipConflictException } from "./notification.error";
import { PushTokenService } from "./push-token.service";

describe("PushTokenService", () => {
  let service: PushTokenService;

  const databaseServiceMock = {
    userPushToken: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

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

  it("registers token with upsert when token has no existing owner", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce(null);

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

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

  it("re-activates token when same owner re-registers a previously revoked token", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce({
      userId: "user-1",
      revokedAt: new Date(),
    });

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.upsert).toHaveBeenCalled();
  });

  it("allows re-registering a token previously revoked by another user", async () => {
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce({
      userId: "user-2",
      revokedAt: new Date(),
    });

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.upsert).toHaveBeenCalled();
  });

  it("rejects ownership transfer when token is already active for another user", async () => {
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
