import { NotificationType } from "../notification.interface";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  RecipientType,
  type TemplateData,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingReminderStartMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_REMINDER_START;
  }

  getTemplateKey(type: NotificationType, recipientType: RecipientType): Template | null {
    if (!this.canHandle(type)) return null;

    // Booking reminders are only for clients and chauffeurs, not fleet owners
    if (recipientType === CHAUFFEUR_RECIPIENT_TYPE) {
      return Template.ChauffeurBookingLegStartReminder;
    }
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      return Template.ClientBookingLegStartReminder;
    }
    return null;
  }

  mapVariables(templateData: TemplateData, recipientType: string): Record<string, string | number> {
    if (recipientType === "chauffeur") {
      // ChauffeurBookingLegStartReminder template variables
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
    if (recipientType === "client") {
      // ClientBookingLegStartReminder template variables
      return {
        "1": this.getValue(templateData, "customerName"),
        "2": this.getValue(templateData, "carName"),
        "3": this.getValue(templateData, "legStartTime"),
        "4": this.getValue(templateData, "legEndTime"),
        "5": this.getValue(templateData, "pickupLocation"),
        "6": this.getValue(templateData, "returnLocation"),
        "7": this.getValue(templateData, "chauffeurName"), // Chauffeur name for client
      };
    }
    // Unsupported recipient type
    return {};
  }
}
