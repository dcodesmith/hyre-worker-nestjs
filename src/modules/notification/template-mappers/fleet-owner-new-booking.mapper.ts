import { NotificationType } from "../notification.interface";
import {
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
  type TemplateData,
} from "../template-data.interface";
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
    if (templateData.templateKind !== FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND) {
      return {};
    }
    return {
      "1": this.text(templateData.ownerName),
      "2": this.text(templateData.carName),
      "3": this.text(templateData.customerName),
      "4": this.text(templateData.startDate),
      "5": this.text(templateData.endDate),
      "6": this.text(templateData.pickupLocation),
      "7": this.text(templateData.returnLocation),
      "8": this.text(templateData.totalAmount),
      "9": this.text(templateData.id),
    };
  }
}
