import { VehicleType } from "@prisma/client";
import { z } from "zod";
import { WhatsAppToolInputValidationException } from "../whatsapp-agent.error";

export const searchVehicleCategorySchema = z.enum(
  Object.values(VehicleType) as [VehicleType, ...VehicleType[]],
);
export const searchBookingTypeSchema = z.enum(["DAY", "NIGHT", "FULL_DAY", "AIRPORT_PICKUP"]);
export const quoteBookingTypeSchema = z.enum(["DAY", "NIGHT", "FULL_DAY"]);
export const createBookingTypeSchema = z.enum(["DAY", "NIGHT", "FULL_DAY"]);

export const searchVehiclesToolInputSchema = z
  .object({
    pickupDate: z.string().min(1),
    dropoffDate: z.string().min(1).optional(),
    bookingType: searchBookingTypeSchema.optional(),
    vehicleModel: z.string().min(1).optional(),
    vehicleColor: z.string().min(1).optional(),
    vehicleCategory: searchVehicleCategorySchema.optional(),
    pickupTime: z.string().min(1).optional(),
    pickupLocation: z.string().min(1).optional(),
    dropoffLocation: z.string().min(1).optional(),
    flightNumber: z.string().min(1).optional(),
  })
  .strict();

export const getQuoteToolInputSchema = z
  .object({
    vehicleId: z.string().min(1),
    pickupDate: z.string().min(1),
    dropoffDate: z.string().min(1).optional(),
    bookingType: quoteBookingTypeSchema,
  })
  .strict();

export const createBookingToolInputSchema = z
  .object({
    vehicleId: z.string().min(1),
    pickupDate: z.string().min(1),
    dropoffDate: z.string().min(1).optional(),
    bookingType: createBookingTypeSchema,
    pickupLocation: z.string().min(1),
    pickupTime: z.string().min(1).optional(),
    customerName: z.string().min(1),
    customerPhone: z.string().min(1),
    specialRequests: z.string().optional(),
  })
  .strict();

export const checkBookingStatusToolInputSchema = z
  .object({
    bookingReference: z.string().min(1),
  })
  .strict();

export const sendPaymentLinkToolInputSchema = z
  .object({
    bookingId: z.string().min(1),
  })
  .strict();

export const whatsappAgentToolSchemas = {
  search_vehicles: searchVehiclesToolInputSchema,
  get_quote: getQuoteToolInputSchema,
  create_booking: createBookingToolInputSchema,
  check_booking_status: checkBookingStatusToolInputSchema,
  send_payment_link: sendPaymentLinkToolInputSchema,
} as const;

export type WhatsAppAgentToolName = keyof typeof whatsappAgentToolSchemas;

export type SearchVehiclesToolInput = z.infer<typeof searchVehiclesToolInputSchema>;
export type GetQuoteToolInput = z.infer<typeof getQuoteToolInputSchema>;
export type CreateBookingToolInput = z.infer<typeof createBookingToolInputSchema>;
export type CheckBookingStatusToolInput = z.infer<typeof checkBookingStatusToolInputSchema>;
export type SendPaymentLinkToolInput = z.infer<typeof sendPaymentLinkToolInputSchema>;

export interface WhatsAppAgentToolDefinition {
  name: WhatsAppAgentToolName;
  description: string;
  inputSchema: z.ZodTypeAny;
}

export const whatsappAgentDefinedToolDefinitions: readonly WhatsAppAgentToolDefinition[] = [
  {
    name: "search_vehicles",
    description:
      "Search available chauffeur-driven vehicles. Use when customer wants to see options.",
    inputSchema: searchVehiclesToolInputSchema,
  },
  {
    name: "get_quote",
    description: "Get pricing for a specific vehicle and booking period.",
    inputSchema: getQuoteToolInputSchema,
  },
  {
    name: "create_booking",
    description: "Create a booking after customer confirms pricing and pickup details.",
    inputSchema: createBookingToolInputSchema,
  },
  {
    name: "check_booking_status",
    description: "Check status of an existing booking by reference.",
    inputSchema: checkBookingStatusToolInputSchema,
  },
  {
    name: "send_payment_link",
    description: "Generate payment link for a pending booking.",
    inputSchema: sendPaymentLinkToolInputSchema,
  },
] as const;

export const whatsappAgentEnabledToolNames = ["search_vehicles"] as const;

export type WhatsAppEnabledToolName = (typeof whatsappAgentEnabledToolNames)[number];

export const whatsappAgentEnabledToolDefinitions = whatsappAgentDefinedToolDefinitions.filter(
  (tool): tool is WhatsAppAgentToolDefinition & { name: WhatsAppEnabledToolName } =>
    (whatsappAgentEnabledToolNames as readonly string[]).includes(tool.name),
);

export function parseWhatsAppAgentToolInput<TToolName extends WhatsAppAgentToolName>(
  toolName: TToolName,
  input: unknown,
): z.infer<(typeof whatsappAgentToolSchemas)[TToolName]> {
  const schema = whatsappAgentToolSchemas[toolName];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new WhatsAppToolInputValidationException(toolName, issues.join("; "));
  }
  return parsed.data as z.infer<(typeof whatsappAgentToolSchemas)[TToolName]>;
}
