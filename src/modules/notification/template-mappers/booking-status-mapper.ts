import { NotificationType } from "../notification.types";
import { type TemplateData } from "../template-data.types";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingStatusMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_STATUS_CHANGE;
  }

  getTemplateKey(type: NotificationType, _recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;
    return Template.BookingStatusUpdate;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: string,
  ): Record<string, string | number> {
    return {
      "1": this.getValue(templateData, "customerName"),
      "2": this.getValue(templateData, "carName"),
      "3": this.getValue(templateData, "title"),
      "4": this.getValue(templateData, "status"),
      "5": this.getValue(templateData, "startDate"),
      "6": this.getValue(templateData, "endDate"),
      "7": this.getValue(templateData, "pickupLocation"),
      "8": this.getValue(templateData, "returnLocation"),
      "9": this.getValue(templateData, "totalAmount"),
    };
  }
}
