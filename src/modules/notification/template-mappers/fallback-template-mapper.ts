import { NotificationType } from "../notification.types";
import { type TemplateData } from "../template-data.types";
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
    // Fallback to basic variables that work across templates
    return {
      "1": this.getValue(templateData, "customerName"),
      "2": this.getValue(templateData, "carName"),
      "3": this.getValue(templateData, "legStartTime") || this.getValue(templateData, "startDate"),
      "4": this.getValue(templateData, "legEndTime") || this.getValue(templateData, "endDate"),
      "5": this.getValue(templateData, "pickupLocation"),
      "6": this.getValue(templateData, "returnLocation"),
      "7": this.getValue(templateData, "chauffeurName"),
      "8": this.getValue(templateData, "bookingId"),
    };
  }
}
