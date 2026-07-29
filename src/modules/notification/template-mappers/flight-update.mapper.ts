import { type FlightNotificationType, NotificationType } from "../notification.interface";
import {
  FLIGHT_UPDATE_TEMPLATE_KIND,
  type RecipientType,
  type TemplateData,
} from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

const FLIGHT_NOTIFICATION_TYPES = new Set<NotificationType>([
  NotificationType.FLIGHT_ARRIVED,
  NotificationType.FLIGHT_DEPARTED,
  NotificationType.FLIGHT_DELAYED,
  NotificationType.FLIGHT_CANCELLED,
  NotificationType.FLIGHT_DIVERTED,
  NotificationType.FLIGHT_GATE_CHANGED,
  NotificationType.FLIGHT_TERMINAL_CHANGED,
  NotificationType.FLIGHT_DELAY_RECOVERED,
  NotificationType.FLIGHT_REINSTATED,
  NotificationType.FLIGHT_ASSIGNMENT_SNAPSHOT,
]);

export class FlightUpdateMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): type is FlightNotificationType {
    return FLIGHT_NOTIFICATION_TYPES.has(type);
  }

  getTemplateKey(type: NotificationType, _recipientType: RecipientType): Template | null {
    return this.canHandle(type) ? Template.FlightOperationalUpdate : null;
  }

  mapVariables(
    templateData: TemplateData,
    _recipientType: RecipientType,
  ): Record<string, string | number> {
    if (templateData.templateKind !== FLIGHT_UPDATE_TEMPLATE_KIND) {
      throw new Error("Invalid template data for FlightAware update");
    }

    return {
      "1": templateData.recipientName,
      "2": templateData.flightNumber,
      "3": templateData.bookingReference,
      "4": templateData.updateTitle,
      "5": templateData.updateBody,
      "6": templateData.expectedArrival,
      "7": templateData.pickupActivationTime,
      "8": templateData.arrivalLocation,
    };
  }
}
