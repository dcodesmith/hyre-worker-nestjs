import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import twilio, { type Twilio } from "twilio";
import { MessageInstance } from "twilio/lib/rest/api/v2010/account/message";
import type { EnvConfig } from "../../config/env.config";
import { Template } from "./whatsapp.interface";

export { Template } from "./whatsapp.interface";

@Injectable()
export class WhatsAppService {
  private readonly twilioClient: Twilio;
  private readonly whatsAppNumber: string;
  private readonly contentSidMap: Partial<Record<Template, string>>;

  constructor(
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppService.name);
    const accountSid = this.configService.get("TWILIO_ACCOUNT_SID", { infer: true });
    const authToken = this.configService.get("TWILIO_AUTH_TOKEN", { infer: true });
    this.whatsAppNumber = this.configService.get("TWILIO_WHATSAPP_NUMBER", { infer: true });
    this.contentSidMap = {
      [Template.BookingStatusUpdate]: this.configService.get(
        "TWILIO_BOOKING_STATUS_UPDATE_CONTENT_SID",
        { infer: true },
      ),
      [Template.ClientBookingLegStartReminder]: this.configService.get(
        "TWILIO_CLIENT_BOOKING_LEG_START_REMINDER_CONTENT_SID",
        { infer: true },
      ),
      [Template.ChauffeurBookingLegStartReminder]: this.configService.get(
        "TWILIO_CHAUFFEUR_BOOKING_LEG_START_REMINDER_CONTENT_SID",
        { infer: true },
      ),
      [Template.ClientBookingLegEndReminder]: this.configService.get(
        "TWILIO_CLIENT_BOOKING_LEG_END_REMINDER_CONTENT_SID",
        { infer: true },
      ),
      [Template.ChauffeurBookingLegEndReminder]: this.configService.get(
        "TWILIO_CHAUFFEUR_BOOKING_LEG_END_REMINDER_CONTENT_SID",
        { infer: true },
      ),
      [Template.BookingConfirmation]: this.configService.get(
        "TWILIO_BOOKING_CONFIRMATION_CONTENT_SID",
        { infer: true },
      ),
      [Template.BookingCancellationClient]: this.configService.get(
        "TWILIO_BOOKING_CANCELLATION_CLIENT_CONTENT_SID",
        { infer: true },
      ),
      [Template.BookingCancellationFleetOwner]: this.configService.get(
        "TWILIO_BOOKING_CANCELLATION_FLEET_OWNER_CONTENT_SID",
        { infer: true },
      ),
      [Template.FleetOwnerBookingNotification]: this.configService.get(
        "TWILIO_FLEET_OWNER_BOOKING_NOTIFICATION_CONTENT_SID",
        { infer: true },
      ),
      [Template.BookingExtensionConfirmation]: this.configService.get(
        "TWILIO_BOOKING_EXTENSION_CONFIRMATION_CONTENT_SID",
        { infer: true },
      ),
      [Template.FlightOperationalUpdate]: this.configService.get(
        "TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID",
        { infer: true },
      ),
      [Template.PayoutSucceeded]: this.configService.get("TWILIO_PAYOUT_SUCCEEDED_CONTENT_SID", {
        infer: true,
      }),
      [Template.RefundSucceeded]: this.configService.get("TWILIO_REFUND_SUCCEEDED_CONTENT_SID", {
        infer: true,
      }),
    };

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
    const contentSid = this.contentSidMap[templateKey];
    const maskedRecipient = this.maskPhone(to);

    if (!contentSid) {
      this.logger.error({ templateKey }, "Could not find SID for template key");
      throw new Error(`WhatsApp template is not configured: ${templateKey}`);
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

      throw error;
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
