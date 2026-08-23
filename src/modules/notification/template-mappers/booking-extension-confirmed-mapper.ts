import { NotificationType } from "../notification.interface";
import {
  BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  type TemplateData,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingExtensionConfirmedMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_EXTENSION_CONFIRMED;
  }

  getTemplateKey(type: NotificationType, _recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;
    return Template.BookingExtensionConfirmation;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: string,
  ): Record<string, string | number> {
    if (templateData.templateKind !== BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND) {
      return {};
    }
    return {
      "1": templateData.customerName,
      "2": templateData.carName,
      "3": templateData.legDate,
      "4": this.formatExtensionHours(templateData.extensionHours),
      "5": templateData.from,
      "6": templateData.to,
    };
  }

  private formatExtensionHours(hours: number): string {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
}
