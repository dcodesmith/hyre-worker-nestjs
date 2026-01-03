import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "./email.service";

// Mock Resend before importing EmailService
const mockSend = vi.fn();
const mockResend = {
  emails: {
    send: mockSend,
  },
};

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => mockResend),
}));

describe("EmailService", () => {
  let service: EmailService;
  let configService: ConfigService;

  beforeEach(async () => {
    mockSend.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              const config: Record<string, string> = {
                RESEND_API_KEY: "test-api-key",
                APP_NAME: "Test App",
                RESEND_FROM_EMAIL: "test@example.com",
                SENDER_NAME: "Test Sender",
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have config service injected", () => {
    expect(configService).toBeDefined();
  });

  describe("sendEmail", () => {
    const emailData = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    };

    it("should send email successfully", async () => {
      const mockResult = {
        data: { id: "email-123" },
        error: null,
      };

      mockSend.mockResolvedValueOnce(mockResult);

      const result = await service.sendEmail(emailData);

      expect(mockSend).toHaveBeenCalledWith({
        from: "Test Sender from Test App <test@example.com>",
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
      });
      expect(result).toEqual(mockResult);
    });

    it("should throw error when API returns error", async () => {
      const mockResult = {
        data: null,
        error: { message: "API Error", name: "ResendError" },
      };

      mockSend.mockResolvedValueOnce(mockResult);

      await expect(service.sendEmail(emailData)).rejects.toThrow("Resend API error");
    });

    it("should throw error when send fails", async () => {
      const error = new Error("Network error");
      mockSend.mockRejectedValueOnce(error);

      await expect(service.sendEmail(emailData)).rejects.toThrow(error);
    });

    it("should format from address correctly", async () => {
      const mockResult = {
        data: { id: "email-123" },
        error: null,
      };

      mockSend.mockResolvedValueOnce(mockResult);

      await service.sendEmail(emailData);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Test Sender from Test App <test@example.com>",
        }),
      );
    });
  });
});
