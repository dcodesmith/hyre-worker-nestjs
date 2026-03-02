import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { LANGGRAPH_BUTTON_ID } from "./langgraph.const";
import { LangGraphExtractionFailedException } from "./langgraph.error";
import type { BookingAgentState, ExtractionResult, InteractiveReply } from "./langgraph.interface";
import type { LangGraphOpenAIClient } from "./langgraph.tokens";
import { LANGGRAPH_OPENAI_CLIENT } from "./langgraph.tokens";
import {
  isAgentRequestControl,
  isCancelIntentControl,
  isLikelyAffirmativeControl,
  isLikelyNegativeControl,
  normalizeControlText,
} from "./langgraph-control-intent.policy";
import { buildExtractorSystemPrompt } from "./prompts/extractor.prompt";

const extractionSchema = z.object({
  intent: z.enum([
    "greeting",
    "provide_info",
    "update_info",
    "select_option",
    "confirm",
    "reject",
    "cancel",
    "reset",
    "new_booking",
    "ask_question",
    "request_agent",
    "unknown",
  ]),
  draftPatch: z.object({
    bookingType: z.enum(["DAY", "NIGHT", "FULL_DAY", "AIRPORT_PICKUP"]).optional(),
    pickupDate: z.string().optional(),
    pickupTime: z.string().optional(),
    dropoffDate: z.string().optional(),
    durationDays: z.number().optional(),
    pickupLocation: z.string().optional(),
    dropoffLocation: z.string().optional(),
    vehicleType: z
      .enum(["SEDAN", "SUV", "LUXURY_SEDAN", "LUXURY_SUV", "VAN", "CROSSOVER"])
      .optional(),
    color: z.string().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    flightNumber: z.string().optional(),
    notes: z.string().optional(),
  }),
  selectionHint: z.string().nullish(),
  preferenceHint: z.string().nullish(),
  question: z.string().nullish(),
  confidence: z.number().min(0).max(1),
});

@Injectable()
export class LangGraphExtractorService {
  private readonly logger = new Logger(LangGraphExtractorService.name);

  constructor(@Inject(LANGGRAPH_OPENAI_CLIENT) private readonly openai: LangGraphOpenAIClient) {}

  async extract(state: BookingAgentState): Promise<ExtractionResult> {
    const {
      conversationId,
      inboundMessage,
      inboundInteractive,
      draft,
      lastShownOptions,
      stage,
      messages,
    } = state;

    if (inboundInteractive) {
      return this.handleInteractiveReply(inboundInteractive, lastShownOptions);
    }

    const deterministicResult = this.getDeterministicTextResult(inboundMessage, stage);
    if (deterministicResult) {
      return deterministicResult;
    }

    try {
      this.logger.debug("Starting extraction", { conversationId, inboundMessage, stage });
      const systemPrompt = buildExtractorSystemPrompt({
        currentDraft: draft,
        lastShownOptions,
        stage,
        messages,
      });
      const response = await this.openai.invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: inboundMessage },
      ]);
      this.logger.debug("Extraction response received", { conversationId });

      let content = "";
      if (typeof response.content === "string") {
        content = response.content;
      } else if (
        Array.isArray(response.content) &&
        response.content.length > 0 &&
        response.content[0]?.type === "text"
      ) {
        content = String(response.content[0].text ?? "");
      }

      const parsed = JSON.parse(content);
      const validated = extractionSchema.parse(parsed);

      return {
        intent: validated.intent,
        draftPatch: validated.draftPatch,
        selectionHint: validated.selectionHint,
        preferenceHint: validated.preferenceHint,
        question: validated.question,
        confidence: validated.confidence,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Extraction failed: ${errorMessage}`, {
        conversationId,
        inboundMessage,
        stack: errorStack,
      });
      throw new LangGraphExtractionFailedException(conversationId, errorMessage);
    }
  }

  private static readonly BUTTON_RESULT_MAP: Record<string, ExtractionResult> = {
    [LANGGRAPH_BUTTON_ID.CONFIRM]: { intent: "confirm", draftPatch: {}, confidence: 1 },
    [LANGGRAPH_BUTTON_ID.RETRY_BOOKING]: { intent: "confirm", draftPatch: {}, confidence: 1 },
    [LANGGRAPH_BUTTON_ID.YES]: { intent: "confirm", draftPatch: {}, confidence: 1 },
    [LANGGRAPH_BUTTON_ID.NO]: { intent: "reject", draftPatch: {}, confidence: 1 },
    [LANGGRAPH_BUTTON_ID.REJECT]: { intent: "reject", draftPatch: {}, confidence: 1 },
    [LANGGRAPH_BUTTON_ID.DAY]: {
      intent: "provide_info",
      draftPatch: { bookingType: "DAY" },
      confidence: 1,
    },
    [LANGGRAPH_BUTTON_ID.NIGHT]: {
      intent: "provide_info",
      draftPatch: { bookingType: "NIGHT" },
      confidence: 1,
    },
    [LANGGRAPH_BUTTON_ID.FULL_DAY]: {
      intent: "provide_info",
      draftPatch: { bookingType: "FULL_DAY" },
      confidence: 1,
    },
    [LANGGRAPH_BUTTON_ID.SHOW_OTHERS]: {
      intent: "reject",
      draftPatch: {},
      preferenceHint: "show_alternatives",
      confidence: 1,
    },
    [LANGGRAPH_BUTTON_ID.MORE_OPTIONS]: {
      intent: "reject",
      draftPatch: {},
      preferenceHint: "show_alternatives",
      confidence: 1,
    },
    [LANGGRAPH_BUTTON_ID.CANCEL]: { intent: "cancel", draftPatch: {}, confidence: 1 },
    [LANGGRAPH_BUTTON_ID.AGENT]: { intent: "request_agent", draftPatch: {}, confidence: 1 },
  };

  private static readonly UNKNOWN_RESULT: ExtractionResult = {
    intent: "unknown",
    draftPatch: {},
    confidence: 0.5,
  };

  private handleInteractiveReply(
    interactive: InteractiveReply,
    lastShownOptions: BookingAgentState["lastShownOptions"],
  ): ExtractionResult {
    if (interactive.type === "button") {
      const buttonId = interactive.buttonId ?? "";

      // Check for vehicle selection button (e.g., "select_vehicle:veh_123")
      if (buttonId.startsWith("select_vehicle:")) {
        const vehicleId = buttonId.replace("select_vehicle:", "");
        const selectedVehicle = lastShownOptions.find((v) => v.id === vehicleId);
        if (selectedVehicle) {
          return {
            intent: "select_option",
            draftPatch: {
              make: selectedVehicle.make,
              model: selectedVehicle.model,
              color: selectedVehicle.color ?? undefined,
            },
            selectionHint: vehicleId,
            confidence: 1,
          };
        }
      }

      // Check for raw vehicle ID from Content Template buttons
      // Twilio Content Templates send the button payload directly as the ID
      const selectedByRawId = lastShownOptions.find((v) => v.id === buttonId);
      if (selectedByRawId) {
        this.logger.log("Vehicle selected via raw ID button", {
          vehicleId: buttonId,
          vehicle: `${selectedByRawId.make} ${selectedByRawId.model}`,
        });
        return {
          intent: "select_option",
          draftPatch: {
            make: selectedByRawId.make,
            model: selectedByRawId.model,
            color: selectedByRawId.color ?? undefined,
          },
          selectionHint: buttonId,
          confidence: 1,
        };
      }

      // Check standard button mappings
      const result = LangGraphExtractorService.BUTTON_RESULT_MAP[buttonId];
      if (result) return result;
    }

    if (interactive.type === "list_reply") {
      const result = this.getListReplyResult(interactive, lastShownOptions);
      if (result) return result;
    }

    return LangGraphExtractorService.UNKNOWN_RESULT;
  }

  private getListReplyResult(
    interactive: InteractiveReply,
    lastShownOptions: BookingAgentState["lastShownOptions"],
  ): ExtractionResult | null {
    const rowId = interactive.listRowId ?? "";
    if (!rowId.startsWith("vehicle:")) return null;

    const vehicleId = rowId.replace("vehicle:", "");
    const selectedVehicle = lastShownOptions.find((v) => v.id === vehicleId);
    if (!selectedVehicle) return null;

    return {
      intent: "select_option",
      draftPatch: {
        make: selectedVehicle.make,
        model: selectedVehicle.model,
        color: selectedVehicle.color ?? undefined,
      },
      selectionHint: vehicleId,
      confidence: 1,
    };
  }

  private getDeterministicTextResult(
    inboundMessage: string,
    stage: BookingAgentState["stage"],
  ): ExtractionResult | null {
    const normalized = normalizeControlText(inboundMessage);
    if (!normalized) {
      return null;
    }

    if (isAgentRequestControl(normalized)) {
      return { intent: "request_agent", draftPatch: {}, confidence: 1 };
    }

    if (isCancelIntentControl(normalized)) {
      return { intent: "cancel", draftPatch: {}, confidence: 1 };
    }

    if (stage === "confirming") {
      if (isLikelyAffirmativeControl(normalized)) {
        return { intent: "confirm", draftPatch: {}, confidence: 1 };
      }
      if (isLikelyNegativeControl(normalized)) {
        return { intent: "reject", draftPatch: {}, confidence: 1 };
      }
    }

    return null;
  }
}
