import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import type { AuthSession } from "../auth/guards/session.guard";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

const profile = {
  name: "Ada Lovelace",
  phoneNumber: "+2348012345678",
  city: "Lagos",
  address: "12 Marina",
  marketingConsent: false,
};

const sessionUser: AuthSession["user"] = {
  id: "user-1",
  email: "ada@example.com",
  emailVerified: true,
  name: "Ada Lovelace",
  createdAt: new Date("2026-01-15T00:00:00.000Z"),
  updatedAt: new Date("2026-01-15T00:00:00.000Z"),
  image: null,
  roles: ["user"],
};

describe("UsersController", () => {
  let controller: UsersController;
  let usersService: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            getCurrentUserProfile: vi.fn(),
            updateCurrentUserProfile: vi.fn(),
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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<UsersController>(UsersController);
    usersService = module.get<UsersService>(UsersService);
  });

  it("returns the current user's profile", async () => {
    vi.mocked(usersService.getCurrentUserProfile).mockResolvedValue(profile);

    const result = await controller.getCurrentUserProfile(sessionUser);

    expect(usersService.getCurrentUserProfile).toHaveBeenCalledWith("user-1");
    expect(result).toEqual(profile);
  });

  it("updates the current user's profile", async () => {
    const updated = { ...profile, city: "Abuja" };
    vi.mocked(usersService.updateCurrentUserProfile).mockResolvedValue(updated);

    const result = await controller.updateCurrentUserProfile(sessionUser, {
      city: "Abuja",
    });

    expect(usersService.updateCurrentUserProfile).toHaveBeenCalledWith("user-1", {
      city: "Abuja",
    });
    expect(result).toEqual(updated);
  });
});
