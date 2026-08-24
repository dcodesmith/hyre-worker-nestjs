import { NotificationType } from "../notification.interface";
import {
  BOOKING_REMINDER_TEMPLATE_KIND,
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

  mapVariables(
    templateData: TemplateData,
    recipientType: RecipientType,
  ): Record<string, string | number> {
    if (templateData.templateKind !== BOOKING_REMINDER_TEMPLATE_KIND) {
      return {};
    }
    if (recipientType === CHAUFFEUR_RECIPIENT_TYPE) {
      return {
        "1": this.text(templateData.chauffeurName),
        "2": this.text(templateData.carName),
        "3": this.text(templateData.legStartTime),
        "4": this.text(templateData.legEndTime),
        "5": this.text(templateData.pickupLocation),
        "6": this.text(templateData.returnLocation),
        "7": this.text(templateData.customerName),
      };
    }
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      return {
        "1": this.text(templateData.customerName),
        "2": this.text(templateData.carName),
        "3": this.text(templateData.legStartTime),
        "4": this.text(templateData.legEndTime),
        "5": this.text(templateData.pickupLocation),
        "6": this.text(templateData.returnLocation),
        "7": this.text(templateData.chauffeurName),
      };
    }
    return {};
  }
}
