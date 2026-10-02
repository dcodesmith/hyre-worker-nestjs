import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import { PhoneVerificationService } from "../verification/phone-verification.service";
import { VerificationThrottlerGuard } from "../verification/verification-throttler.guard";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

const sessionUser = { id: "user-session" } as AuthSession["user"];

describe("UsersController", () => {
  let controller: UsersController;
  let usersService: {
    getCurrentUserProfile: ReturnType<typeof vi.fn>;
    updateCurrentUserProfile: ReturnType<typeof vi.fn>;
  };
  let phoneVerificationService: {
    send: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    usersService = {
      getCurrentUserProfile: vi.fn(),
      updateCurrentUserProfile: vi.fn(),
    };
    phoneVerificationService = {
      send: vi.fn(),
      check: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersService },
        { provide: PhoneVerificationService, useValue: phoneVerificationService },
      ],
    })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(VerificationThrottlerGuard)
      .useValue({ canActivate: () => true })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get(UsersController);
  });

  it("loads the profile for the authenticated session", async () => {
    usersService.getCurrentUserProfile.mockResolvedValue({ phoneVerified: true });

    await controller.getCurrentUserProfile(sessionUser);

    expect(usersService.getCurrentUserProfile).toHaveBeenCalledWith("user-session");
  });

  it("updates the profile for the authenticated session", async () => {
    const body = { city: "Lagos" };
    usersService.updateCurrentUserProfile.mockResolvedValue({ city: "Lagos" });

    await controller.updateCurrentUserProfile(sessionUser, body);

    expect(usersService.updateCurrentUserProfile).toHaveBeenCalledWith("user-session", body);
  });

  it("sends a phone verification code for the session user", async () => {
    const body = { phoneNumber: "+2348012345678" };
    phoneVerificationService.send.mockResolvedValue({ status: "PENDING" });

    await controller.sendPhoneVerification(sessionUser, body);

    expect(phoneVerificationService.send).toHaveBeenCalledWith("user-session", body);
  });

  it("checks a phone verification code for the session user", async () => {
    const body = { phoneNumber: "+2348012345678", code: "123456" };
    phoneVerificationService.check.mockResolvedValue({ status: "VERIFIED" });

    await controller.checkPhoneVerification(sessionUser, body);

    expect(phoneVerificationService.check).toHaveBeenCalledWith("user-session", body);
  });
});
