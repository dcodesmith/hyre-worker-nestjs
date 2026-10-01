import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { ExtractNode } from "./extract.node";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { LangGraphExtractorService } from "./langgraph-extractor.service";

describe("ExtractNode", () => {
  let moduleRef: TestingModule;
  let extractNode: ExtractNode;
  const extractorServiceMock = {
    extract: vi.fn(),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        ExtractNode,
        { provide: LangGraphExtractorService, useValue: extractorServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    extractNode = moduleRef.get(ExtractNode);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("returns an unknown extraction and leaves draft state untouched on failure", async () => {
    extractorServiceMock.extract.mockRejectedValue(new Error("429"));

    const result = await extractNode.run({
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
      nextNode: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    });

    expect(result.error).toBe(LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE);
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
