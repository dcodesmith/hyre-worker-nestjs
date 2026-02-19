import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { MessagingService } from "./messaging.service";

describe("MessagingService", () => {
  let service: MessagingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessagingService],
    }).compile();

    service = module.get<MessagingService>(MessagingService);
  });

  it("handles Twilio status callback without throwing", async () => {
    await expect(
      service.handleTwilioStatusCallback({
        MessageSid: "SM123",
        MessageStatus: "sent",
      }),
    ).resolves.toBeUndefined();
  });
});
