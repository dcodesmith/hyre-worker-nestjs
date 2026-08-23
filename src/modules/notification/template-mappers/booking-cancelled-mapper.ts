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
        "1": templateData.ownerName,
        "2": templateData.carName,
        "3": templateData.cancellationReason,
        "4": templateData.customerName,
        "5": templateData.startDate,
        "6": templateData.endDate,
        "7": templateData.pickupLocation,
        "8": templateData.returnLocation,
        "9": templateData.totalAmount,
      };
    }

    return {
      "1": templateData.customerName,
      "2": templateData.carName,
      "3": templateData.totalAmount,
      "4": templateData.cancellationReason,
      "5": templateData.startDate,
      "6": templateData.endDate,
      "7": templateData.pickupLocation,
      "8": templateData.returnLocation,
    };
  }
}
