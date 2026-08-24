import { NotificationType } from "../notification.interface";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
  type TemplateData,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class BookingCancelledMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.BOOKING_CANCELLED;
  }

  getTemplateKey(type: NotificationType, recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;

    if (recipientType === FLEET_OWNER_RECIPIENT_TYPE) {
      return Template.BookingCancellationFleetOwner;
    }
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      return Template.BookingCancellationClient;
    }
    return null;
  }

  mapVariables(templateData: TemplateData, recipientType: string): Record<string, string | number> {
    if (templateData.templateKind !== BOOKING_CANCELLED_TEMPLATE_KIND) {
      return {};
    }

    if (recipientType === FLEET_OWNER_RECIPIENT_TYPE) {
      return {
        "1": this.text(templateData.ownerName),
        "2": this.text(templateData.carName),
        "3": this.text(templateData.cancellationReason),
        "4": this.text(templateData.customerName),
        "5": this.text(templateData.startDate),
        "6": this.text(templateData.endDate),
        "7": this.text(templateData.pickupLocation),
        "8": this.text(templateData.returnLocation),
        "9": this.text(templateData.totalAmount),
      };
    }

    return {
      "1": this.text(templateData.customerName),
      "2": this.text(templateData.carName),
      "3": this.text(templateData.totalAmount),
      "4": this.text(templateData.cancellationReason),
      "5": this.text(templateData.startDate),
      "6": this.text(templateData.endDate),
      "7": this.text(templateData.pickupLocation),
      "8": this.text(templateData.returnLocation),
    };
  }
}
