import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { Template, WhatsAppService } from "./whatsapp.service";

const twilioMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
}));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    messages: {
      create: twilioMocks.createMessage,
    },
  })),
}));

async function createService(flightTemplateSid?: string): Promise<WhatsAppService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WhatsAppService,
      {
        provide: ConfigService,
        useValue: {
          get: vi.fn((key: string) => {
            if (key === "TWILIO_ACCOUNT_SID") return "AC123";
            if (key === "TWILIO_AUTH_TOKEN") return "token";
            if (key === "TWILIO_WHATSAPP_NUMBER") return "+14155238886";
            if (key === "TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID") {
              return flightTemplateSid;
            }
            return undefined;
          }),
        },
      },
    ],
  })
    .useMocker(mockPinoLoggerToken)
    .compile();

  return module.get(WhatsAppService);
}

describe("WhatsAppService", () => {
  let service: WhatsAppService;
  const flightTemplateSid = "HX1234567890abcdef1234567890abcdef";

  beforeEach(async () => {
    twilioMocks.createMessage.mockReset();
    twilioMocks.createMessage.mockResolvedValue({ sid: "SM123", status: "queued" });
    service = await createService(flightTemplateSid);
  });

  it("uses the configured operational flight template", async () => {
    await service.sendMessage({
      to: "+2348012345678",
      templateKey: Template.FlightOperationalUpdate,
      variables: { "1": "Fleet Owner", "2": "BA74" },
    });

    expect(twilioMocks.createMessage).toHaveBeenCalledWith({
      to: "whatsapp:+2348012345678",
      from: "whatsapp:+14155238886",
      contentSid: flightTemplateSid,
      contentVariables: JSON.stringify({ "1": "Fleet Owner", "2": "BA74" }),
    });
  });

  it("rejects delivery when the operational template is not configured", async () => {
    service = await createService();

    await expect(
      service.sendMessage({
        to: "+2348012345678",
        templateKey: Template.FlightOperationalUpdate,
        variables: {},
      }),
    ).rejects.toThrow("WhatsApp template is not configured");
    expect(twilioMocks.createMessage).not.toHaveBeenCalled();
  });

  it("propagates Twilio failures so BullMQ can retry", async () => {
    twilioMocks.createMessage.mockRejectedValueOnce(new Error("Twilio unavailable"));

    await expect(
      service.sendMessage({
        to: "+2348012345678",
        templateKey: Template.FlightOperationalUpdate,
        variables: {},
      }),
    ).rejects.toThrow("Twilio unavailable");
  });
});
