import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingController } from "./messaging.controller";
import { MessagingService } from "./messaging.service";

describe("MessagingController", () => {
  let controller: MessagingController;
  let messagingService: MessagingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        {
          provide: MessagingService,
          useValue: {
            handleTwilioStatusCallback: vi.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === "TWILIO_AUTH_TOKEN") return "test-token";
              if (key === "TWILIO_WEBHOOK_URL")
                return "http://localhost:3000/api/messaging/webhook/twilio";
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<MessagingController>(MessagingController);
    messagingService = module.get<MessagingService>(MessagingService);
  });

  it("forwards webhook payload to messaging service", async () => {
    vi.mocked(messagingService.handleTwilioStatusCallback).mockResolvedValue(undefined);

    const payload = {
      MessageSid: "SM123",
      MessageStatus: "delivered",
    };

    await controller.handleTwilioWebhook(payload);

    expect(messagingService.handleTwilioStatusCallback).toHaveBeenCalledWith(payload);
  });
});
