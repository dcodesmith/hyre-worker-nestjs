import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { Template, WhatsAppService } from "./whatsapp.service";

const twilioMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
}));
const configuredTemplates = [
  [Template.BookingStatusUpdate, "TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID"],
  [Template.ClientBookingLegStartReminder, "TWILIO_CLIENT_BOOKING_LEG_START_REMINDER_CONTENT_SID"],
  [
    Template.ChauffeurBookingLegStartReminder,
    "TWILIO_CHAUFFEUR_BOOKING_LEG_START_REMINDER_CONTENT_SID",
  ],
  [Template.ClientBookingLegEndReminder, "TWILIO_CLIENT_BOOKING_LEG_END_REMINDER_CONTENT_SID"],
  [
    Template.ChauffeurBookingLegEndReminder,
    "TWILIO_CHAUFFEUR_BOOKING_LEG_END_REMINDER_CONTENT_SID",
  ],
  [Template.BookingConfirmation, "TWILIO_BOOKING_CONFIRMATION_CONTENT_SID"],
  [Template.BookingCancellationClient, "TWILIO_BOOKING_CANCELLATION_CLIENT_CONTENT_SID"],
  [Template.BookingCancellationFleetOwner, "TWILIO_BOOKING_CANCELLATION_FLEET_OWNER_CONTENT_SID"],
  [Template.FleetOwnerBookingNotification, "TWILIO_FLEET_OWNER_BOOKING_NOTIFICATION_CONTENT_SID"],
  [Template.BookingExtensionConfirmation, "TWILIO_BOOKING_EXTENSION_CONFIRMATION_CONTENT_SID"],
  [Template.FlightOperationalUpdate, "TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID"],
  [Template.PayoutSucceeded, "TWILIO_PAYOUT_SUCCEEDED_CONTENT_SID"],
  [Template.RefundSucceeded, "TWILIO_REFUND_SUCCEEDED_CONTENT_SID"],
] as const;

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    messages: {
      create: twilioMocks.createMessage,
    },
  })),
}));

async function createService(
  contentSids: Record<string, string | undefined> = {},
): Promise<WhatsAppService> {
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
            return contentSids[key];
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
    service = await createService({
      TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID: flightTemplateSid,
    });
  });

  it.each(configuredTemplates)("uses the configured SID for %s", async (template, envKey) => {
    const configuredService = await createService({
      [envKey]: flightTemplateSid,
    });

    await configuredService.sendMessage({
      to: "+2348012345678",
      templateKey: template,
      variables: { "1": "Customer" },
    });

    expect(twilioMocks.createMessage).toHaveBeenCalledWith({
      to: "whatsapp:+2348012345678",
      from: "whatsapp:+14155238886",
      contentSid: flightTemplateSid,
      contentVariables: JSON.stringify({ "1": "Customer" }),
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
