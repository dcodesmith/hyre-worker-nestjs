import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { ExtractAction } from "./extract.action";
import { BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE } from "./conversation.const";
import { createDefaultLocationValidationState } from "./conversation.interface";
import { BookingAgentExtractorService } from "./booking-agent-extractor.service";

describe("ExtractAction", () => {
  let moduleRef: TestingModule;
  let extractAction: ExtractAction;
  const extractorServiceMock = {
    extract: vi.fn(),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        ExtractAction,
        { provide: BookingAgentExtractorService, useValue: extractorServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    extractAction = moduleRef.get(ExtractAction);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns an unknown extraction and leaves draft state untouched on failure", async () => {
    extractorServiceMock.extract.mockRejectedValue(new Error("429"));

    const result = await extractAction.run({
      conversationId: "conv_1",
      inboundMessage: "hello",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "collecting",
      turnCount: 1,
      messages: [],
      draft: { pickupLocation: "Ikoyi" },
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: null,
      holdId: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentLink: null,
      preferences: {},
      response: null,
      outboxItems: [],
      extraction: null,
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.error).toBe(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
    expect(result.extraction).toEqual({
      intent: "unknown",
      draftPatch: {},
      confidence: 0,
    });
    expect(result.statusMessage).toBeNull();
    expect(result).not.toHaveProperty("stage");
    expect(result).not.toHaveProperty("draft");
    expect(result).not.toHaveProperty("availableOptions");
    expect(result).not.toHaveProperty("lastShownOptions");
    expect(result).not.toHaveProperty("selectedOption");
  });
});
