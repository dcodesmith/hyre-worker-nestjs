import { NotificationType } from "../notification.interface";
import { type TemplateData } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingConfirmedMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_CONFIRMED;
  }

  getTemplateKey(type: NotificationType, _recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;
    return Template.BookingConfirmation;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: string,
  ): Record<string, string | number> {
    return {
      "1": this.getValue(templateData, "customerName"),
      "2": this.getValue(templateData, "carName"),
      "3": this.getValue(templateData, "startDate"),
      "4": this.getValue(templateData, "endDate"),
      "5": this.getValue(templateData, "pickupLocation"),
      "6": this.getValue(templateData, "returnLocation"),
      "7": this.getValue(templateData, "totalAmount"),
    };
  }
}
