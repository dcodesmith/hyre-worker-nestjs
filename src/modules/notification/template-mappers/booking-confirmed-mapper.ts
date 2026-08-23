import { NotificationType } from "../notification.interface";
import { BOOKING_CONFIRMED_TEMPLATE_KIND, type TemplateData } from "../template-data.interface";
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
    if (templateData.templateKind !== BOOKING_CONFIRMED_TEMPLATE_KIND) {
      return {};
    }
    return {
      "1": templateData.customerName,
      "2": templateData.carName,
      "3": templateData.startDate,
      "4": templateData.endDate,
      "5": templateData.pickupLocation,
      "6": templateData.returnLocation,
      "7": templateData.totalAmount,
    };
  }
}
