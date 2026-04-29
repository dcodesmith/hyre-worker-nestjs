import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import twilio, { Twilio } from "twilio";
import { MessageInstance } from "twilio/lib/rest/api/v2010/account/message";

export enum Template {
  BookingStatusUpdate = "bookingStatusUpdate",
  ClientBookingLegStartReminder = "clientBookingLegStartReminder",
  ChauffeurBookingLegStartReminder = "chauffeurBookingLegStartReminder",
  ClientBookingLegEndReminder = "clientBookingLegEndReminder",
  ChauffeurBookingLegEndReminder = "chauffeurBookingLegEndReminder",
  BookingConfirmation = "bookingConfirmation",
  BookingCancellationClient = "bookingCancellationClient",
  BookingCancellationFleetOwner = "bookingCancellationFleetOwner",
  FleetOwnerBookingNotification = "fleetOwnerBookingNotification",
  BookingExtensionConfirmation = "bookingExtensionConfirmation",
}

const contentSidMap: Record<Template, string> = {
  [Template.BookingStatusUpdate]: "HX199f51dda921d5a781b2424b82b931a5",
  [Template.ClientBookingLegStartReminder]: "HX862149f716a87ae25ce34151140bfc60",
  [Template.ChauffeurBookingLegStartReminder]: "HX8d44b0747c995713d129d77f4cc3c860",
  [Template.ClientBookingLegEndReminder]: "HX0c8470054c0ff1a0b43c06fe196e2ec3",
  [Template.ChauffeurBookingLegEndReminder]: "HX9faf29432a18e9f8f8283a5e281e5a3c",
  [Template.BookingConfirmation]: "HXac9f0b83ee03d47fe2f2969173dac354",
  [Template.BookingCancellationClient]: "HXd32930f086ad7e2c3ac976e245c314f9",
  [Template.BookingCancellationFleetOwner]: "HX5ad3e909d6c011f24e00f4706a78a90e",
  [Template.FleetOwnerBookingNotification]: "HXaeda40fabb6c33f323c1f101e0a10165",
  [Template.BookingExtensionConfirmation]: "HXaeda40fabb6c33f323c1f101e0a10165",
};

@Injectable()
export class WhatsAppService {
  private readonly twilioClient: Twilio;
  private readonly whatsAppNumber: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppService.name);
    const accountSid = this.configService.get<string>("TWILIO_ACCOUNT_SID");
    const authToken = this.configService.get<string>("TWILIO_AUTH_TOKEN");
    this.whatsAppNumber = this.configService.get<string>("TWILIO_WHATSAPP_NUMBER");

    try {
      this.twilioClient = twilio(accountSid, authToken);
      this.logger.info("Twilio client initialized successfully");
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to initialize Twilio client",
      );
      throw error;
    }
  }

  async sendMessage({
    to,
    variables,
    templateKey,
  }: {
    to: string;
    variables: Record<string, string | number>;
    templateKey: Template;
  }): Promise<MessageInstance | null> {
    const contentSid = contentSidMap[templateKey];
    const maskedRecipient = this.maskPhone(to);

    if (!contentSid) {
      this.logger.error({ templateKey }, "Could not find SID for template key");
      return null;
    }

    this.logger.info(
      { recipient: maskedRecipient, templateKey, contentSid },
      "Attempting to send WhatsApp template",
    );

    try {
      const message = await this.twilioClient.messages.create({
        to: `whatsapp:${to}`,
        from: `whatsapp:${this.whatsAppNumber}`,
        contentSid,
        contentVariables: JSON.stringify(variables),
      });

      this.logger.info(
        {
          sid: message.sid,
          status: message.status,
          recipient: maskedRecipient,
          templateKey,
        },
        "WhatsApp message sent successfully",
      );
      return message;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        {
          recipient: maskedRecipient,
          templateKey,
          error: errorMessage,
        },
        "Error sending WhatsApp message",
      );

      return null;
    }
  }

  private maskPhone(value: string): string {
    const digits = value.replaceAll(/\D/g, "");
    if (digits.length <= 4) {
      return "****";
    }

    const suffix = digits.slice(-4);
    return `${"*".repeat(digits.length - 4)}${suffix}`;
  }
}
