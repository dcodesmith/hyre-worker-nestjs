import { NotificationType } from "../notification.interface";
import { BOOKING_STATUS_TEMPLATE_KIND, type TemplateData } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingStatusMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return (
      type === NotificationType.BOOKING_STATUS_CHANGE ||
      type === NotificationType.CHAUFFEUR_ASSIGNED ||
      type === NotificationType.BOOKING_UPDATED
    );
  }

  getTemplateKey(type: NotificationType, _recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;
    return Template.BookingStatusUpdate;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: string,
  ): Record<string, string | number> {
    if (templateData.templateKind !== BOOKING_STATUS_TEMPLATE_KIND) {
      return {};
    }
    return {
      "1": this.text(templateData.customerName),
      "2": this.text(templateData.carName),
      "3": this.text(templateData.title),
      "4": this.text(templateData.status),
      "5": this.text(templateData.startDate),
      "6": this.text(templateData.endDate),
      "7": this.text(templateData.pickupLocation),
      "8": this.text(templateData.returnLocation),
      "9": this.text(templateData.totalAmount),
    };
  }
}
