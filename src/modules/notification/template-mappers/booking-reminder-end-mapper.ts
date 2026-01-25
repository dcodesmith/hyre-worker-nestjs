import { NotificationType } from "../notification.interface";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  RecipientType,
  type TemplateData,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingReminderEndMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_REMINDER_END;
  }

  getTemplateKey(type: NotificationType, recipientType: RecipientType): Template | null {
    if (!this.canHandle(type)) return null;

    // Booking reminders are only for clients and chauffeurs, not fleet owners
    if (recipientType === CHAUFFEUR_RECIPIENT_TYPE) {
      return Template.ChauffeurBookingLegEndReminder;
    }
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      return Template.ClientBookingLegEndReminder;
    }
    return null;
  }

  mapVariables(templateData: TemplateData, recipientType: string): Record<string, string | number> {
    if (recipientType === CHAUFFEUR_RECIPIENT_TYPE) {
      // ChauffeurBookingLegEndReminder template variables
      return {
        "1": this.getValue(templateData, "chauffeurName"),
        "2": this.getValue(templateData, "carName"),
        "3": this.getValue(templateData, "legStartTime"),
        "4": this.getValue(templateData, "legEndTime"),
        "5": this.getValue(templateData, "pickupLocation"),
        "6": this.getValue(templateData, "returnLocation"),
        "7": this.getValue(templateData, "customerName"), // Customer name for chauffeur
      };
    }
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      // ClientBookingLegEndReminder template variables
      return {
        "1": this.getValue(templateData, "customerName"),
        "2": this.getValue(templateData, "carName"),
        "3": this.getValue(templateData, "legStartTime"),
        "4": this.getValue(templateData, "legEndTime"),
        "5": this.getValue(templateData, "pickupLocation"),
        "6": this.getValue(templateData, "returnLocation"),
        "7": this.getValue(templateData, "chauffeurName"), // Chauffeur name for client
        "8": this.getValue(templateData, "bookingId"), // Booking ID for end reminders
      };
    }
    // Unsupported recipient type
    return {};
  }
}
