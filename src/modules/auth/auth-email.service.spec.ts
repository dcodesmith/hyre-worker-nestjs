import { Test, TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { EmailService } from "../email/email.service";
import { AuthEmailService } from "./auth-email.service";

vi.mock("../../templates/emails", () => ({
  renderAuthOTPEmail: vi.fn().mockResolvedValue("<html>OTP Email</html>"),
}));

describe("AuthEmailService", () => {
  let service: AuthEmailService;
  let logger: PinoLogger;

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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<AuthEmailService>(AuthEmailService);
    logger = module.get(PinoLogger);
  });
  describe("sendOTPEmail", () => {
    const testEmail = "user@example.com";
    const testOTP = "123456";

    it("should not log the OTP or full email address", async () => {
      mockEmailService.sendEmail.mockResolvedValueOnce({ data: { id: "email-123" } });

      await service.sendOTPEmail(testEmail, testOTP);

      expect(logger.info).toHaveBeenCalledWith({ email: "u***@example.com" }, "Sending OTP email");
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ email: testEmail, otp: testOTP }),
        expect.any(String),
      );
    });
  });
});
