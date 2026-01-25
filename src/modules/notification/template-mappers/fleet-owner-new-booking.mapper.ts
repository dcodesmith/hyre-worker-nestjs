import { NotificationType } from "../notification.interface";
import { type TemplateData } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class FleetOwnerNewBookingMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.FLEET_OWNER_NEW_BOOKING;
  }

  getTemplateKey(type: NotificationType, _recipientType: string): Template | null {
    if (!this.canHandle(type)) return null;
    return Template.FleetOwnerBookingNotification;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: string,
  ): Record<string, string | number> {
    return {
      "1": this.getValue(templateData, "ownerName"),
      "2": this.getValue(templateData, "carName"),
      "3": this.getValue(templateData, "customerName"),
      "4": this.getValue(templateData, "startDate"),
      "5": this.getValue(templateData, "endDate"),
      "6": this.getValue(templateData, "pickupLocation"),
      "7": this.getValue(templateData, "returnLocation"),
      "8": this.getValue(templateData, "totalAmount"),
      "9": this.getValue(templateData, "id"),
    };
  }
}
