import { Annotation } from "@langchain/langgraph";
import type {
  AgentResponse,
  BookingAgentState,
  BookingDraft,
  BookingStage,
  ConversationMessage,
  ExtractionResult,
  InteractiveReply,
  LangGraphOutboxItem,
  UserPreferences,
  VehicleSearchOption,
} from "./langgraph.interface";
import { createDefaultLocationValidationState } from "./langgraph.interface";

/**
 * Helper to create an Annotation channel with a default value.
 * Required when you want a default but no special reducer logic.
 */
function AnnotationWithDefault<T>(defaultValue: T) {
  return Annotation<T>({
    reducer: (_current: T, update: T) => update,
    default: () => defaultValue,
  });
}

export const BookingAgentAnnotation = Annotation.Root({
  messages: Annotation<ConversationMessage[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  conversationId: Annotation<string>,
  customerId: AnnotationWithDefault<string | null>(null),
  inboundMessage: AnnotationWithDefault<string>(""),
  inboundMessageId: AnnotationWithDefault<string>(""),
  inboundInteractive: AnnotationWithDefault<InteractiveReply | undefined>(undefined),
  draft: Annotation<BookingDraft & { __clear?: boolean }>({
    reducer: (current, update) => {
      // Special flag to clear the draft completely
      if ("__clear" in update && update.__clear === true) {
        const { __clear: _, ...rest } = update;
        return rest;
      }
      return { ...current, ...update };
    },
    default: () => ({}),
  }),
  stage: Annotation<BookingStage>({
    reducer: (_, update) => update,
    default: () => "greeting",
  }),
  turnCount: Annotation<number>({
    reducer: (current, update) => (typeof update === "number" ? update : current + 1),
    default: () => 0,
  }),
  extraction: AnnotationWithDefault<ExtractionResult | null>(null),
  availableOptions: Annotation<VehicleSearchOption[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  lastShownOptions: Annotation<VehicleSearchOption[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  selectedOption: AnnotationWithDefault<VehicleSearchOption | null>(null),
  holdId: AnnotationWithDefault<string | null>(null),
  holdExpiresAt: AnnotationWithDefault<string | null>(null),
  bookingId: AnnotationWithDefault<string | null>(null),
  paymentLink: AnnotationWithDefault<string | null>(null),
  preferences: Annotation<UserPreferences & { __clear?: boolean }>({
    reducer: (current, update) => {
      // Special flag to clear preferences completely
      if ("__clear" in update && update.__clear === true) {
        const { __clear: _, ...rest } = update;
        return rest;
      }
      return { ...current, ...update };
    },
    default: () => ({}),
  }),
  response: AnnotationWithDefault<AgentResponse | null>(null),
  outboxItems: Annotation<LangGraphOutboxItem[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  locationValidation: Annotation<BookingAgentState["locationValidation"]>({
    reducer: (_, update) => update,
    default: () => createDefaultLocationValidationState(),
  }),
  nextNode: AnnotationWithDefault<string | null>(null),
  error: AnnotationWithDefault<string | null>(null),
  statusMessage: AnnotationWithDefault<string | null>(null),
});

export type AnnotationState = typeof BookingAgentAnnotation.State;
