import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryFailedException } from "./email.error";
import { SmtpEmailTransport } from "./smtp-email.transport";

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({
    sendMail,
  }));

  return { mockSendMail: sendMail, mockCreateTransport: createTransport };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}));

describe("SmtpEmailTransport", () => {
  let transport: SmtpEmailTransport;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpEmailTransport,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              const config: Record<string, unknown> = {
                APP_NAME: "Test App",
                EMAIL_FROM: "smtp@example.com",
                SENDER_NAME: "Test Sender",
                SMTP_HOST: "127.0.0.1",
                SMTP_PORT: 1025,
                SMTP_SECURE: false,
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    transport = module.get<SmtpEmailTransport>(SmtpEmailTransport);
  });

  it("should initialize SMTP transporter once", () => {
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      auth: undefined,
    });
  });

  it("should send email through SMTP transport", async () => {
    mockSendMail.mockResolvedValueOnce({
      messageId: "smtp-message-id",
      response: "250 Accepted",
    });

    const result = await transport.sendEmail({
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: "Test Sender from Test App <smtp@example.com>",
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test HTML</p>",
    });
    expect(result).toEqual({
      data: {
        id: "smtp-message-id",
      },
    });
  });

  it("should throw EmailDeliveryFailedException when SMTP send fails", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("Connection refused"));

    await expect(
      transport.sendEmail({
        to: "recipient@example.com",
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
      }),
    ).rejects.toThrow(EmailDeliveryFailedException);
  });
});
