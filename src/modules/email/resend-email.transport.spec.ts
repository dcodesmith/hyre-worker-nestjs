import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResendEmailTransport } from "./resend-email.transport";

const mockSend = vi.fn();
const mockResend = {
  emails: {
    send: mockSend,
  },
};

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => mockResend),
}));

describe("ResendEmailTransport", () => {
  let transport: ResendEmailTransport;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResendEmailTransport,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              const config: Record<string, string> = {
                RESEND_API_KEY: "test-api-key",
                APP_NAME: "Test App",
                EMAIL_FROM: "test@example.com",
                SENDER_NAME: "Test Sender",
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    transport = module.get<ResendEmailTransport>(ResendEmailTransport);
  });

  it("should send email successfully", async () => {
    const mockResult = {
      data: { id: "email-123" },
      error: null,
    };
    mockSend.mockResolvedValueOnce(mockResult);

    const result = await transport.sendEmail({
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    });

    expect(mockSend).toHaveBeenCalledWith({
      from: "Test Sender from Test App <test@example.com>",
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    });
    expect(result).toEqual(mockResult);
  });

  it("should throw error when API returns an error", async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { message: "API Error", name: "ResendError" },
    });

    await expect(
      transport.sendEmail({
        to: "recipient@example.com",
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
      }),
    ).rejects.toThrow("Resend API error");
  });
});
