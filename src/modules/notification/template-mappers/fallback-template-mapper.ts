import { NotificationType } from "../notification.interface";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_CONFIRMED_TEMPLATE_KIND,
  BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
  type TemplateData,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class FallbackTemplateMapper extends BaseTemplateMapper {
  canHandle(_type: NotificationType): boolean {
    // This mapper handles any type as a fallback
    return true;
  }

  getTemplateKey(_type: NotificationType, _recipientType: string): Template | null {
    // No specific template for unknown types
    return null;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: string,
  ): Record<string, string | number> {
    if (templateData.templateKind === BOOKING_REMINDER_TEMPLATE_KIND) {
      return {
        "1": templateData.customerName,
        "2": templateData.carName,
        "3": templateData.legStartTime,
        "4": templateData.legEndTime,
        "5": templateData.pickupLocation,
        "6": templateData.returnLocation,
        "7": templateData.chauffeurName,
        "8": templateData.bookingId,
      };
    }

    if (
      templateData.templateKind === BOOKING_STATUS_TEMPLATE_KIND ||
      templateData.templateKind === BOOKING_CONFIRMED_TEMPLATE_KIND ||
      templateData.templateKind === BOOKING_CANCELLED_TEMPLATE_KIND ||
      templateData.templateKind === BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND ||
      templateData.templateKind === FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND
    ) {
      return {
        "1": templateData.customerName,
        "2": templateData.carName,
        "3": templateData.startDate,
        "4": templateData.endDate,
        "5": templateData.pickupLocation,
        "6": templateData.returnLocation,
        "7": templateData.chauffeurName,
        "8": templateData.id,
      };
    }

    return {
      "1": "",
      "2": "",
      "3": "",
      "4": "",
      "5": "",
      "6": "",
      "7": "",
      "8": "",
    };
  }
}
