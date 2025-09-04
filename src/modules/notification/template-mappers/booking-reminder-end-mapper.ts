import { NotificationType } from "../notification.types";
import { type TemplateData } from "../template-data.types";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingReminderEndMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_REMINDER_END;
  }

  getTemplateKey(type: NotificationType, recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;

    return recipientType === "chauffeur"
      ? Template.ChauffeurBookingLegEndReminder
      : Template.ClientBookingLegEndReminder;
  }

  mapVariables(templateData: TemplateData, recipientType: string): Record<string, string | number> {
    if (recipientType === "chauffeur") {
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
    } else {
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
  }
}
