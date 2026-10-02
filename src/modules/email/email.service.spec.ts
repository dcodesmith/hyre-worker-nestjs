import { Test, TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { EMAIL_TRANSPORT_TOKEN } from "./email.const";
import { EmailDeliveryFailedException } from "./email.error";
import { EmailService } from "./email.service";

describe("EmailService", () => {
  let service: EmailService;
  let logger: PinoLogger;
  const mockTransport = {
    sendEmail: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: EMAIL_TRANSPORT_TOKEN,
          useValue: mockTransport,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<EmailService>(EmailService);
    logger = module.get(PinoLogger);
  });

  describe("sendEmail", () => {
    const emailData = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    it("should throw error when transport fails", async () => {
      const error = new Error("Network error");
      mockTransport.sendEmail.mockRejectedValueOnce(error);

      await expect(service.sendEmail(emailData)).rejects.toThrow(EmailDeliveryFailedException);
      expect(logger.error).toHaveBeenCalledWith(
        {
          recipient: "r***@example.com",
          err: error,
        },
        "Failed to send email",
      );
    });

    it("does not duplicate transport logging for known email errors", async () => {
      const error = new EmailDeliveryFailedException("SMTP request failed");
      mockTransport.sendEmail.mockRejectedValueOnce(error);

      await expect(service.sendEmail(emailData)).rejects.toBe(error);

      expect(logger.error).not.toHaveBeenCalled();
    });

    it("forwards the full payload including idempotencyKey to the transport", async () => {
      const payload = {
        ...emailData,
        idempotencyKey: "account-link_conv-1_user_123",
      };
      mockTransport.sendEmail.mockResolvedValueOnce({ data: { id: "email-1" } });

      await service.sendEmail(payload);

      expect(mockTransport.sendEmail).toHaveBeenCalledWith(payload);
    });
  });
});
