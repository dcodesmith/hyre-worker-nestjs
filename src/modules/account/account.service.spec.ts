import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { AccountDeleteFailedException, AccountUserNotFoundException } from "./account.error";
import { AccountService } from "./account.service";

describe("AccountService", () => {
  let service: AccountService;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        {
          provide: DatabaseService,
          useValue: {
            user: {
              findUnique: vi.fn(),
              delete: vi.fn(),
            },
            booking: {
              updateMany: vi.fn(),
            },
            $transaction: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AccountService>(AccountService);
    databaseService = module.get<DatabaseService>(DatabaseService);
  });

  it("throws not found when user does not exist", async () => {
    vi.mocked(databaseService.user.findUnique).mockResolvedValue(null);

    await expect(service.deleteUserAccount("missing-user")).rejects.toThrow(
      AccountUserNotFoundException,
    );
  });

  it("anonymizes bookings and deletes the user", async () => {
    vi.mocked(databaseService.user.findUnique).mockResolvedValue(
      createUser({
        id: "user-1",
        email: "user@example.com",
      }),
    );
    vi.mocked(databaseService.$transaction).mockResolvedValue([{ count: 2 }, {}] as never);

    const result = await service.deleteUserAccount("user-1");

    expect(databaseService.booking.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { userId: null, guestUser: null },
    });
    expect(databaseService.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
    expect(result).toEqual({ success: true });
  });

  it("throws account deletion failed when transaction throws unexpected error", async () => {
    vi.mocked(databaseService.user.findUnique).mockResolvedValue(
      createUser({
        id: "user-1",
        email: "user@example.com",
      }),
    );
    vi.mocked(databaseService.$transaction).mockRejectedValue(new Error("db failure"));

    await expect(service.deleteUserAccount("user-1")).rejects.toThrow(AccountDeleteFailedException);
  });
});
