import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { EnvConfig } from "src/config/env.config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../notification/email.service";
import { AuthEmailService } from "./auth-email.service";

vi.mock("../../templates/emails", () => ({
  renderAuthOTPEmail: vi.fn().mockResolvedValue("<html>OTP Email</html>"),
}));

describe("AuthEmailService", () => {
  let service: AuthEmailService;
  let emailService: EmailService;

  const mockEmailService = {
    sendEmail: vi.fn(),
  };

  const mockConfigService = {
    get: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfigService.get.mockImplementation((key: keyof EnvConfig) => {
      if (key === "NODE_ENV") return "production";
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthEmailService,
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: ConfigService<EnvConfig>,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<AuthEmailService>(AuthEmailService);
    emailService = module.get<EmailService>(EmailService);
  });
  describe("sendOTPEmail", () => {
    const testEmail = "user@example.com";
    const testOTP = "123456";

    it("should send OTP email successfully", async () => {
      mockEmailService.sendEmail.mockResolvedValueOnce({ data: { id: "email-123" } });

      await service.sendOTPEmail(testEmail, testOTP);

      expect(mockEmailService.sendEmail).toHaveBeenCalledTimes(1);
      expect(mockEmailService.sendEmail).toHaveBeenCalledWith({
        to: testEmail,
        subject: "Your Verification Code",
        html: "<html>OTP Email</html>",
      });
    });

    it("should throw error when email service fails", async () => {
      const error = new Error("Email sending failed");
      mockEmailService.sendEmail.mockRejectedValueOnce(error);

      await expect(service.sendOTPEmail(testEmail, testOTP)).rejects.toThrow(error);
    });

    it("should call renderAuthOTPEmail with correct OTP", async () => {
      const { renderAuthOTPEmail } = await import("../../templates/emails");
      mockEmailService.sendEmail.mockResolvedValueOnce({ data: { id: "email-123" } });

      await service.sendOTPEmail(testEmail, testOTP);

      expect(renderAuthOTPEmail).toHaveBeenCalledWith({ otp: testOTP });
    });

    it("should log OTP and skip email in development", async () => {
      mockConfigService.get.mockImplementation((key: keyof EnvConfig) => {
        if (key === "NODE_ENV") return "development";
        return undefined;
      });

      await service.sendOTPEmail(testEmail, testOTP);

      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
    });
  });
});
