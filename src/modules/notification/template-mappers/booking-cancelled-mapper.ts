import { NotificationType } from "../notification.interface";
import {
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
    if (recipientType === FLEET_OWNER_RECIPIENT_TYPE) {
      return {
        "1": this.getValue(templateData, "ownerName"),
        "2": this.getValue(templateData, "carName"),
        "3": this.getValue(templateData, "cancellationReason"),
        "4": this.getValue(templateData, "customerName"),
        "5": this.getValue(templateData, "startDate"),
        "6": this.getValue(templateData, "endDate"),
        "7": this.getValue(templateData, "pickupLocation"),
        "8": this.getValue(templateData, "returnLocation"),
        "9": this.getValue(templateData, "totalAmount"),
      };
    }

    return {
      "1": this.getValue(templateData, "customerName"),
      "2": this.getValue(templateData, "carName"),
      "3": this.getValue(templateData, "totalAmount"),
      "4": this.getValue(templateData, "cancellationReason"),
      "5": this.getValue(templateData, "startDate"),
      "6": this.getValue(templateData, "endDate"),
      "7": this.getValue(templateData, "pickupLocation"),
      "8": this.getValue(templateData, "returnLocation"),
    };
  }
}
