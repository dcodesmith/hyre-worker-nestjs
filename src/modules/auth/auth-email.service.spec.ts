import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../notification/email.service";
import { AuthEmailService } from "./auth-email.service";

// Mock the email template renderer
vi.mock("../../templates/emails", () => ({
  renderAuthOTPEmail: vi.fn().mockResolvedValue("<html>OTP Email</html>"),
}));

describe("AuthEmailService", () => {
  let service: AuthEmailService;
  let emailService: EmailService;

  const mockEmailService = {
    sendEmail: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthEmailService,
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
      ],
    }).compile();

    service = module.get<AuthEmailService>(AuthEmailService);
    emailService = module.get<EmailService>(EmailService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have email service injected", () => {
    expect(emailService).toBeDefined();
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
  });
});
