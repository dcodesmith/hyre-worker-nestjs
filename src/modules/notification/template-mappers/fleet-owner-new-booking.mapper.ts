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
      "1": templateData.ownerName,
      "2": templateData.carName,
      "3": templateData.customerName,
      "4": templateData.startDate,
      "5": templateData.endDate,
      "6": templateData.pickupLocation,
      "7": templateData.returnLocation,
      "8": templateData.totalAmount,
      "9": templateData.id,
    };
  }
}
