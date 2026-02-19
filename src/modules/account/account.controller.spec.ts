import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";

describe("AccountController", () => {
  let controller: AccountController;
  let accountService: AccountService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [
        {
          provide: AccountService,
          useValue: {
            deleteUserAccount: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["user"]),
          },
        },
      ],
    }).compile();

    controller = module.get<AccountController>(AccountController);
    accountService = module.get<AccountService>(AccountService);
  });

  it("deletes the current user's account", async () => {
    vi.mocked(accountService.deleteUserAccount).mockResolvedValue({ success: true });

    const result = await controller.deleteCurrentUserAccount({
      id: "user-1",
    } as never);

    expect(accountService.deleteUserAccount).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({ success: true });
  });
});
