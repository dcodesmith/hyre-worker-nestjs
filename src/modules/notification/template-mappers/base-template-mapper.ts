import { NotificationType } from "../notification.interface";
import { type TemplateData } from "../template-data.interface";
import { Template } from "../whatsapp.service";

export interface TemplateVariableMapper {
  /**
   * Gets the WhatsApp template key for a given notification type and recipient
   */
  getTemplateKey(type: NotificationType, recipientType: string): Template | null;

  /**
   * Maps template data to WhatsApp variables for a specific template
   */
  mapVariables(templateData: TemplateData, recipientType: string): Record<string, string | number>;

  /**
   * Checks if this mapper can handle the given notification type
   */
  canHandle(type: NotificationType): boolean;
}

export abstract class BaseTemplateMapper implements TemplateVariableMapper {
  abstract getTemplateKey(type: NotificationType, recipientType: string): Template | null;
  abstract mapVariables(
    templateData: TemplateData,
    recipientType: string,
  ): Record<string, string | number>;
  abstract canHandle(type: NotificationType): boolean;

  /**
   * Helper method to safely get template data values
   */
  protected getValue(
    templateData: TemplateData,
    key: string,
    fallback: string | number = "",
  ): string | number {
    return (templateData as any)?.[key] ?? fallback;
  }
}
