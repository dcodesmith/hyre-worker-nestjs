import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { z } from "zod";
import { OPENAI_SDK_CLIENT, type OpenAiSdkClient } from "../../openai-sdk/openai-sdk.tokens";
import { getDurationUnitClarification } from "./booking-rules";
import {
  isAgentRequestControl,
  isBareCancelControl,
  isCancelIntentControl,
  isLikelyAffirmativeControl,
  isLikelyNegativeControl,
  normalizeControlText,
} from "./control-intent.policy";
import {
  BOOKING_AGENT_BUTTON_ID,
  BOOKING_AGENT_EXTRACTION_MODEL,
  BOOKING_AGENT_MODEL_MAX_RETRIES,
  BOOKING_AGENT_MODEL_TIMEOUT_MS,
} from "./conversation.const";
import { BookingAgentExtractionFailedException } from "./conversation.error";
import type {
  BookingAgentState,
  ExtractionResult,
  InteractiveReply,
} from "./conversation.interface";
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
    vehicleType: z.enum(["SEDAN", "SUV", "VAN", "CROSSOVER"]).optional(),
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
export class BookingAgentExtractorService {
  constructor(
    @Inject(OPENAI_SDK_CLIENT) private readonly openai: OpenAiSdkClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingAgentExtractorService.name);
  }

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
      this.logger.debug({ conversationId, inboundMessage, stage }, "Starting extraction");
      const systemPrompt = buildExtractorSystemPrompt({
        currentDraft: draft,
        lastShownOptions,
        stage,
        messages,
      });
      const response = await this.openai.chat.completions.create(
        {
          model: BOOKING_AGENT_EXTRACTION_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: inboundMessage },
          ],
          response_format: { type: "json_object" },
        },
        {
          timeout: BOOKING_AGENT_MODEL_TIMEOUT_MS,
          maxRetries: BOOKING_AGENT_MODEL_MAX_RETRIES,
        },
      );
      this.logger.debug({ conversationId }, "Extraction response received");

      const content = response.choices[0]?.message.content ?? "";
      const parsed = JSON.parse(content);
      const validated = extractionSchema.parse(parsed);
      const draftPatch: ExtractionResult["draftPatch"] = { ...validated.draftPatch };
      const clarificationPrompt = getDurationUnitClarification(
        inboundMessage,
        draftPatch.bookingType ?? draft.bookingType,
      );
      if (clarificationPrompt) {
        delete draftPatch.durationDays;
        delete draftPatch.dropoffDate;
      }

      return {
        intent: validated.intent,
        draftPatch,
        selectionHint: validated.selectionHint,
        preferenceHint: validated.preferenceHint,
        question: validated.question,
        clarificationPrompt: clarificationPrompt ?? undefined,
        confidence: validated.confidence,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        {
          conversationId,
          inboundMessage,
          stack: errorStack,
          error: errorMessage,
        },
        "Extraction failed",
      );
      throw new BookingAgentExtractionFailedException(conversationId);
    }
  }

  private static readonly BUTTON_RESULT_MAP: Record<string, ExtractionResult> = {
    [BOOKING_AGENT_BUTTON_ID.CONFIRM]: { intent: "confirm", draftPatch: {}, confidence: 1 },
    [BOOKING_AGENT_BUTTON_ID.RETRY_BOOKING]: { intent: "confirm", draftPatch: {}, confidence: 1 },
    [BOOKING_AGENT_BUTTON_ID.YES]: { intent: "confirm", draftPatch: {}, confidence: 1 },
    [BOOKING_AGENT_BUTTON_ID.NO]: { intent: "reject", draftPatch: {}, confidence: 1 },
    [BOOKING_AGENT_BUTTON_ID.REJECT]: { intent: "reject", draftPatch: {}, confidence: 1 },
    [BOOKING_AGENT_BUTTON_ID.DAY]: {
      intent: "provide_info",
      draftPatch: { bookingType: "DAY" },
      confidence: 1,
    },
    [BOOKING_AGENT_BUTTON_ID.NIGHT]: {
      intent: "provide_info",
      draftPatch: { bookingType: "NIGHT" },
      confidence: 1,
    },
    [BOOKING_AGENT_BUTTON_ID.FULL_DAY]: {
      intent: "provide_info",
      draftPatch: { bookingType: "FULL_DAY" },
      confidence: 1,
    },
    [BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS]: {
      intent: "reject",
      draftPatch: {},
      preferenceHint: "show_alternatives",
      confidence: 1,
    },
    [BOOKING_AGENT_BUTTON_ID.MORE_OPTIONS]: {
      intent: "reject",
      draftPatch: {},
      preferenceHint: "show_alternatives",
      confidence: 1,
    },
    [BOOKING_AGENT_BUTTON_ID.CHANGE_DETAILS]: {
      intent: "ask_question",
      draftPatch: {},
      question:
        "What would you like to change — the car, booking type, date or time, or locations?",
      confidence: 1,
    },
    [BOOKING_AGENT_BUTTON_ID.CANCEL]: { intent: "cancel", draftPatch: {}, confidence: 1 },
    [BOOKING_AGENT_BUTTON_ID.AGENT]: { intent: "request_agent", draftPatch: {}, confidence: 1 },
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
        this.logger.info(
          {
            vehicleId: buttonId,
            vehicle: `${selectedByRawId.make} ${selectedByRawId.model}`,
          },
          "Vehicle selected via raw ID button",
        );
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
      const result = BookingAgentExtractorService.BUTTON_RESULT_MAP[buttonId];
      if (result) return result;
    }

    if (interactive.type === "list_reply") {
      const result = this.getListReplyResult(interactive, lastShownOptions);
      if (result) return result;
    }

    return BookingAgentExtractorService.UNKNOWN_RESULT;
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

    if (stage === "confirming" && isBareCancelControl(normalized)) {
      return { intent: "cancel", draftPatch: {}, confidence: 0.6 };
    }

    if (isCancelIntentControl(normalized)) {
      return { intent: "cancel", draftPatch: {}, confidence: 1 };
    }

    if (
      ["selecting_addons", "selecting_fuel", "selecting_credits"].includes(stage) &&
      (["add", "apply", "skip"].includes(normalized) ||
        isLikelyAffirmativeControl(normalized) ||
        isLikelyNegativeControl(normalized))
    ) {
      return BookingAgentExtractorService.UNKNOWN_RESULT;
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
