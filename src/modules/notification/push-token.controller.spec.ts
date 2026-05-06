import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { PushTokenController } from "./push-token.controller";
import { PushTokenService } from "./push-token.service";

describe("PushTokenController", () => {
  let controller: PushTokenController;
  let pushTokenService: PushTokenService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushTokenController],
      providers: [
        {
          provide: PushTokenService,
          useValue: {
            registerToken: vi.fn(),
            revokeToken: vi.fn(),
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

    controller = module.get<PushTokenController>(PushTokenController);
    pushTokenService = module.get<PushTokenService>(PushTokenService);
  });

  it("registers a push token for the current user", async () => {
    const result = await controller.registerPushToken({ id: "user-1" } as never, {
      token: "ExponentPushToken[abc123]",
      platform: "ios",
    });

    expect(pushTokenService.registerToken).toHaveBeenCalledWith(
      "user-1",
      "ExponentPushToken[abc123]",
      "ios",
    );
    expect(result).toEqual({ success: true });
  });

  it("revokes a push token for the current user", async () => {
    const result = await controller.deletePushToken({ id: "user-1" } as never, {
      token: "ExponentPushToken[abc123]",
    });

    expect(pushTokenService.revokeToken).toHaveBeenCalledWith(
      "user-1",
      "ExponentPushToken[abc123]",
    );
    expect(result).toEqual({ success: true });
  });
});
