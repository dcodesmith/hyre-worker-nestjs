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

  it("returns extraction payload on success", async () => {
    extractorServiceMock.extract.mockResolvedValue({
      intent: "greeting",
      draftPatch: {},
      confidence: 0.9,
    });

    const result = await extractNode.run({
      conversationId: "conv_1",
      inboundMessage: "hello",
      inboundMessageId: "msg_1",
      customerId: null,
      stage: "greeting",
      turnCount: 0,
      messages: [],
      draft: {},
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

    expect(result.extraction?.intent).toBe("greeting");
    expect(result.error).toBeNull();
  });

  it("returns safe fallback state on extraction failure", async () => {
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
    expect(result.stage).toBe("greeting");
    expect(result.availableOptions).toEqual([]);
  });
});
