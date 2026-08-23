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
      "1": templateData.customerName,
      "2": templateData.carName,
      "3": templateData.title,
      "4": templateData.status,
      "5": templateData.startDate,
      "6": templateData.endDate,
      "7": templateData.pickupLocation,
      "8": templateData.returnLocation,
      "9": templateData.totalAmount,
    };
  }
}
