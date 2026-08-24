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
      "1": this.text(templateData.customerName),
      "2": this.text(templateData.carName),
      "3": this.text(templateData.startDate),
      "4": this.text(templateData.endDate),
      "5": this.text(templateData.pickupLocation),
      "6": this.text(templateData.returnLocation),
      "7": this.text(templateData.totalAmount),
    };
  }
}
