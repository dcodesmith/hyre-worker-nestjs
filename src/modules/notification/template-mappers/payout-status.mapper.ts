import { FLEET_OWNER_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { PAYOUT_STATUS_TEMPLATE_KIND, type TemplateData } from "../template-data.interface";
import { Template } from "../whatsapp.service";
import { BaseTemplateMapper } from "./base-template-mapper";

export class PayoutStatusMapper extends BaseTemplateMapper {
  canHandle(type: NotificationType): boolean {
    return type === NotificationType.PAYOUT_STATUS_CHANGED;
  }

  getTemplateKey(type: NotificationType, recipientType: string): Template | null {
    if (!this.canHandle(type) || recipientType !== FLEET_OWNER_RECIPIENT_TYPE) {
      return null;
    }
    return Template.PayoutSucceeded;
  }

  mapVariables(templateData: TemplateData): Record<string, string | number> {
    if (templateData.templateKind !== PAYOUT_STATUS_TEMPLATE_KIND) {
      throw new Error("Invalid template data for payout status notification");
    }

    return {
      "1": templateData.recipientName,
      "2": templateData.amount,
      "3": templateData.bookingReference,
    };
  }
}
