import { format } from "date-fns";
import { getMissingRequiredFields } from "../../booking-agent.helper";
import type {
  BookingAgentState,
  BookingStage,
  BuildResponderUserContextOptions,
  ExtractionResult,
} from "../langgraph.interface";

const STAGE_INSTRUCTIONS: Partial<Record<BookingStage, string>> = {
  presenting_options:
    "INSTRUCTION: Write a SHORT intro message (1 sentence max) saying you found some options. Do NOT list the vehicles - they will be shown as images. Just say something like 'Here are your options!' or 'I found these for you:'\n",
  awaiting_selection:
    "INSTRUCTION: They're choosing. Help them decide or confirm their selection.\n",
  confirming:
    "INSTRUCTION: Summarize the booking details clearly. Show what they selected and ask for final confirmation. Use the confirm/reject buttons below.\n",
  awaiting_payment:
    "INSTRUCTION: The booking has been created! Share the payment link with them and let them know their vehicle is reserved.\n",
  collecting:
    "INSTRUCTION: Ask for ALL missing fields in one message. Do NOT ask for confirmation - just ask for missing fields.\n",
  greeting:
    "INSTRUCTION: Welcome them warmly. Invite them to share their booking details — they can give everything at once or just tell you what they need.\n",
  searching:
    "INSTRUCTION: We are searching for vehicles. This state should not be reached - escalate internally and do not surface internal diagnostics to customers.\n",
};

export function buildResponderSystemPrompt(state: BookingAgentState): string {
  const now = new Date();
  const todayFormatted = format(now, "EEEE, MMMM d, yyyy");
  const timeFormatted = format(now, "h:mm a");

  return `You are Yomide, a friendly booking assistant for Tripdly, a premium chauffeur car service in Lagos.

TODAY: ${todayFormatted}
TIME: ${timeFormatted}

YOUR PERSONALITY:
- Warm, professional, but not stiff
- Natural Nigerian-friendly English
- Proactive — make suggestions, anticipate needs
- Conversational — handle tangents gracefully
- Reference conversation history naturally

BOOKING TYPES (dropoff time is AUTO-CALCULATED, never ask for it):
- Day: 12 hours from pickup time (e.g., 9am pickup → 9pm dropoff)
- Night: Fixed 11pm - 5am
- Full Day: 24 hours from pickup time
- Airport Pickup: Airport pickup (requires flight number)

REQUIRED FIELDS FOR SEARCH (only these 6):
- pickupDate, dropoffDate (auto-calculated from "for X days")
- bookingType (Day, Night, Full Day, or Airport Pickup)
- pickupLocation, dropoffLocation (user can say "same as pickup")
- pickupTime

NEVER ASK FOR:
- Dropoff time (calculated from booking type)
- Contact number, phone, email
- Confirmation of times - just proceed once you have the required fields

YOUR RULES:
1. NEVER invent availability, prices, or booking references
2. Keep messages SHORT (2-3 sentences max)
3. Accept multi-field answers — users can give all details at once
4. Use WhatsApp formatting: *bold* for emphasis
5. Include prices with "incl. VAT" when showing options
6. Be more direct if many turns have passed (turn ${state.turnCount})
7. If user is frustrated, acknowledge and be helpful
8. NEVER ask for contact number or any field not in the required list

GREETING BEHAVIOR:
- When user just says hi/hello, welcome them warmly and invite them to share their booking details
- Let them know they can share everything at once or just tell you what they need
- Don't immediately ask for a specific field — let them lead

COLLECTING INFO:
- ONLY ask for the required fields listed above
- When multiple fields are missing, ask for ALL of them in one message
- If user provides partial info, acknowledge what you got and ask ONLY for missing required fields
- Once all required fields are present, proceed to search — DO NOT ask for anything else

RESPONSE FORMAT:
- Short, conversational messages
- Use numbers for listing options
- End with a question or clear next step
- No JSON, just natural text`;
}

export function buildResponderUserContext(
  state: BookingAgentState,
  options: BuildResponderUserContextOptions,
): string {
  const { stage, draft, extraction, availableOptions, selectedOption, holdId } = state;
  const missingFields = getMissingRequiredFields(draft);

  let context = `CURRENT STATE: ${stage}\n`;
  context += `TURN: ${state.turnCount}\n`;
  context += `DRAFT: ${truncate(JSON.stringify(draft), options.maxDraftContextChars)}\n`;
  context += formatExtractionContext(extraction);
  context += `LATEST MESSAGE: ${truncate(state.inboundMessage, options.maxContextFieldChars)}\n`;

  if (missingFields.length > 0) {
    context += `MISSING REQUIRED FIELDS: ${missingFields.join(", ")}\n`;
    context += "INSTRUCTION: Ask for ALL missing fields in one message. Be concise.\n";
  }

  if (availableOptions.length > 0 && stage !== "presenting_options") {
    context += "AVAILABLE OPTIONS:\n";
    availableOptions.slice(0, options.maxOptionContextItems).forEach((opt, i) => {
      context += `${i + 1}. ${opt.make} ${opt.model} (${opt.color ?? "any"}) - ₦${opt.estimatedTotalInclVat?.toLocaleString() ?? "N/A"} incl. VAT\n`;
    });
    context += "INSTRUCTION: Present these options conversationally. Mention the prices.\n";
  } else if (availableOptions.length > 0 && stage === "presenting_options") {
    context += `FOUND ${availableOptions.length} VEHICLE OPTIONS (will be shown as image cards - do NOT list them)\n`;
  }

  if (selectedOption) {
    const selectedPrice =
      typeof selectedOption.estimatedTotalInclVat === "number"
        ? `₦${selectedOption.estimatedTotalInclVat.toLocaleString()}`
        : "N/A";
    context += `SELECTED: ${selectedOption.make} ${selectedOption.model} - ${selectedPrice}\n`;
  }

  if (holdId) {
    context += "HOLD ACTIVE: Vehicle reserved for 15 minutes\n";
  }

  const stageInstruction = STAGE_INSTRUCTIONS[stage];
  if (stageInstruction) {
    context += stageInstruction;
  }

  return context;
}

function formatExtractionContext(extraction: ExtractionResult | null): string {
  if (!extraction) return "";
  let out = `USER INTENT: ${extraction.intent}\n`;
  if (extraction.question) out += `USER QUESTION: ${extraction.question}\n`;
  if (extraction.selectionHint) out += `SELECTION HINT: ${extraction.selectionHint}\n`;
  if (extraction.preferenceHint) out += `PREFERENCE: ${extraction.preferenceHint}\n`;
  return out;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}
