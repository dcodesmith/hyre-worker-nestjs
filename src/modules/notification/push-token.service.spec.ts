import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
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
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.$transaction.mockImplementation(async (callback) =>
      callback(databaseServiceMock),
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

  it("registers token by creating a new ownership record when token does not exist", async () => {
    databaseServiceMock.userPushToken.create.mockResolvedValueOnce(undefined);

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          token: "ExponentPushToken[abc123]",
          platform: "IOS",
        }),
      }),
    );
    expect(databaseServiceMock.userPushToken.updateMany).not.toHaveBeenCalled();
    expect(databaseServiceMock.userPushToken.findUnique).not.toHaveBeenCalled();
  });

  it("re-activates token when same owner re-registers a previously revoked token", async () => {
    databaseServiceMock.userPushToken.create.mockRejectedValueOnce(createUniqueConstraintError());
    databaseServiceMock.userPushToken.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          token: "ExponentPushToken[abc123]",
          OR: [{ userId: "user-1" }, { revokedAt: { not: null } }],
        },
      }),
    );
  });

  it("allows re-registering a token previously revoked by another user", async () => {
    databaseServiceMock.userPushToken.create.mockRejectedValueOnce(createUniqueConstraintError());
    databaseServiceMock.userPushToken.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.registerToken("user-1", "ExponentPushToken[abc123]", "ios");

    expect(databaseServiceMock.userPushToken.updateMany).toHaveBeenCalled();
  });

  it("rejects ownership transfer when token becomes active for another user during concurrent registration", async () => {
    databaseServiceMock.userPushToken.create.mockRejectedValueOnce(createUniqueConstraintError());
    databaseServiceMock.userPushToken.updateMany.mockResolvedValueOnce({ count: 0 });
    databaseServiceMock.userPushToken.findUnique.mockResolvedValueOnce({
      userId: "user-2",
      revokedAt: null,
    });

    await expect(
      service.registerToken("user-1", "ExponentPushToken[abc123]", "ios"),
    ).rejects.toBeInstanceOf(PushTokenOwnershipConflictException);
    expect(databaseServiceMock.userPushToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          token: "ExponentPushToken[abc123]",
          OR: [{ userId: "user-1" }, { revokedAt: { not: null } }],
        },
        data: {
          userId: "user-1",
          platform: "IOS",
          revokedAt: null,
        },
      }),
    );
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

function createUniqueConstraintError() {
  return Object.assign(Object.create(Prisma.PrismaClientKnownRequestError.prototype), {
    code: "P2002",
  });
}
