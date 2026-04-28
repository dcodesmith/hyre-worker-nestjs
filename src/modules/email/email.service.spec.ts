import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TRANSPORT_TOKEN } from "./email.const";
import { EmailDeliveryFailedException } from "./email.error";
import { EmailService } from "./email.service";

describe("EmailService", () => {
  let service: EmailService;
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
    }).compile();

    service = module.get<EmailService>(EmailService);
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
    });
  });
});
