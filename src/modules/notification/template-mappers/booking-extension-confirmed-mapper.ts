import { NotificationType } from "../notification.interface";
import { type TemplateData } from "../template-data.interface";
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
    return {
      "1": this.getValue(templateData, "customerName"),
      "2": this.getValue(templateData, "carName"),
      "3": this.getValue(templateData, "legDate"),
      "4": this.formatExtensionHours(Number(this.getValue(templateData, "extensionHours", 0))),
      "5": this.getValue(templateData, "from"),
      "6": this.getValue(templateData, "to"),
    };
  }

  private formatExtensionHours(hours: number): string {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
}
