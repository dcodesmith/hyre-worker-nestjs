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

    it("should delegate email sending to the configured transport", async () => {
      const mockResult = {
        data: { id: "email-123" },
      };

      mockTransport.sendEmail.mockResolvedValueOnce(mockResult);

      const result = await service.sendEmail(emailData);

      expect(mockTransport.sendEmail).toHaveBeenCalledWith(emailData);
      expect(result).toEqual(mockResult);
    });

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
  });
});
