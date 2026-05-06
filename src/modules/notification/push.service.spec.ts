import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { PushService } from "./push.service";

const { chunkPushNotificationsMock, sendPushNotificationsAsyncMock, isExpoPushTokenMock } =
  vi.hoisted(() => ({
    chunkPushNotificationsMock: vi.fn(),
    sendPushNotificationsAsyncMock: vi.fn(),
    isExpoPushTokenMock: vi.fn(),
  }));

vi.mock("expo-server-sdk", () => ({
  Expo: class {
    static readonly isExpoPushToken = isExpoPushTokenMock;
    chunkPushNotifications = chunkPushNotificationsMock;
    sendPushNotificationsAsync = sendPushNotificationsAsyncMock;
  },
}));

describe("PushService", () => {
  let service: PushService;

  beforeEach(async () => {
    vi.clearAllMocks();
    isExpoPushTokenMock.mockImplementation(
      (token: string) =>
        token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["),
    );
    chunkPushNotificationsMock.mockImplementation((messages) => [messages]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue(undefined),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<PushService>(PushService);
  });

  it("sends push notifications and reports invalid device tokens", async () => {
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([
      { status: "ok" },
      { status: "error", details: { error: "DeviceNotRegistered" } },
    ]);

    const result = await service.sendPushNotifications({
      tokens: ["ExponentPushToken[a]", "ExponentPushToken[b]"],
      title: "Title",
      body: "Body",
      data: { bookingId: "booking-1" },
    });

    expect(result).toEqual({
      sent: 1,
      failed: 0,
      invalidTokens: ["ExponentPushToken[b]"],
      errors: [
        {
          code: "DeviceNotRegistered",
          retryable: false,
          token: "ExponentPushToken[b]",
          message: undefined,
        },
      ],
    });
    expect(sendPushNotificationsAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("returns invalid-format tokens as non-retryable failures", async () => {
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([{ status: "ok" }]);

    const result = await service.sendPushNotifications({
      tokens: ["invalid-token", "ExponentPushToken[a]"],
      title: "Title",
      body: "Body",
    });

    expect(result).toEqual({
      sent: 1,
      failed: 0,
      invalidTokens: ["invalid-token"],
      errors: [
        {
          code: "INVALID_PUSH_TOKEN_FORMAT",
          retryable: false,
          token: "invalid-token",
          message: "Invalid Expo push token format",
        },
      ],
    });
    expect(sendPushNotificationsAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("does not call Expo when all tokens are invalid format", async () => {
    const result = await service.sendPushNotifications({
      tokens: ["bad-token-a", "bad-token-b"],
      title: "Title",
      body: "Body",
    });

    expect(result).toEqual({
      sent: 0,
      failed: 0,
      invalidTokens: ["bad-token-a", "bad-token-b"],
      errors: [
        {
          code: "INVALID_PUSH_TOKEN_FORMAT",
          retryable: false,
          token: "bad-token-a",
          message: "Invalid Expo push token format",
        },
        {
          code: "INVALID_PUSH_TOKEN_FORMAT",
          retryable: false,
          token: "bad-token-b",
          message: "Invalid Expo push token format",
        },
      ],
    });
    expect(sendPushNotificationsAsyncMock).not.toHaveBeenCalled();
  });
});
