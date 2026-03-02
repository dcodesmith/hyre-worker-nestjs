import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLangGraphStateKey } from "./langgraph.const";
import type { BookingAgentState } from "./langgraph.interface";
import { LANGGRAPH_REDIS_CLIENT } from "./langgraph.tokens";
import { LangGraphStateService } from "./langgraph-state.service";

describe("LangGraphStateService", () => {
  let moduleRef: TestingModule;
  let service: LangGraphStateService;
  let redisMock: {
    get: ReturnType<typeof vi.fn>;
    setex: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let configServiceMock: {
    get: ReturnType<typeof vi.fn>;
  };

  const conversationId = "conv_test_123";
  const stateKey = buildLangGraphStateKey(conversationId);

  beforeEach(async () => {
    redisMock = {
      get: vi.fn(),
      setex: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
    };

    configServiceMock = {
      get: vi.fn().mockReturnValue(10),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        LangGraphStateService,
        {
          provide: LANGGRAPH_REDIS_CLIENT,
          useValue: redisMock,
        },
        {
          provide: ConfigService,
          useValue: configServiceMock,
        },
      ],
    }).compile();

    service = moduleRef.get(LangGraphStateService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  describe("createInitialState", () => {
    it("creates initial state with provided values", () => {
      const messageId = "msg_123";
      const message = "Hello, I need a car";
      const customerId = "cust_456";

      const state = service.createInitialState(conversationId, messageId, message, customerId);

      expect(state.conversationId).toBe(conversationId);
      expect(state.inboundMessage).toBe(message);
      expect(state.inboundMessageId).toBe(messageId);
      expect(state.customerId).toBe(customerId);
      expect(state.stage).toBe("greeting");
      expect(state.turnCount).toBe(0);
      expect(state.messages).toEqual([]);
      expect(state.draft).toEqual({});
      expect(state.availableOptions).toEqual([]);
      expect(state.preferences).toEqual({});
      expect(state.error).toBeNull();
    });

    it("creates initial state with null customerId", () => {
      const state = service.createInitialState(conversationId, "msg_1", "hi", null);

      expect(state.customerId).toBeNull();
    });
  });

  describe("mergeWithExisting", () => {
    it("merges new message into existing state", () => {
      const existingState: Partial<BookingAgentState> = {
        messages: [
          { role: "user", content: "hi", timestamp: "2026-02-27T10:00:00Z" },
          { role: "assistant", content: "hello", timestamp: "2026-02-27T10:00:01Z" },
        ],
        draft: { pickupLocation: "Lagos" },
        stage: "collecting",
        turnCount: 2,
        availableOptions: [],
        lastShownOptions: [],
        preferences: { pricePreference: "budget" },
        holdId: null,
        holdExpiresAt: null,
        bookingId: null,
      };

      const newMessageId = "msg_new";
      const newMessage = "I need an SUV";
      const newCustomerId = "cust_456";

      const merged = service.mergeWithExisting(
        existingState,
        conversationId,
        newMessageId,
        newMessage,
        newCustomerId,
      );

      expect(merged.inboundMessage).toBe(newMessage);
      expect(merged.inboundMessageId).toBe(newMessageId);
      expect(merged.customerId).toBe(newCustomerId);
      expect(merged.stage).toBe("collecting");
      expect(merged.turnCount).toBe(3);
      expect(merged.messages).toHaveLength(2);
      expect(merged.draft.pickupLocation).toBe("Lagos");
      expect(merged.preferences.pricePreference).toBe("budget");
    });

    it("preserves existing customerId when new one is null", () => {
      const existingState: Partial<BookingAgentState> = {
        messages: [],
        draft: {},
        stage: "greeting",
        turnCount: 0,
        availableOptions: [],
        lastShownOptions: [],
        preferences: {},
        holdId: null,
        holdExpiresAt: null,
        bookingId: null,
      };

      const merged = service.mergeWithExisting(existingState, conversationId, "msg_1", "hi", null);

      expect(merged.customerId).toBeNull();
    });

    it("clears transient fields on merge", () => {
      const existingState: Partial<BookingAgentState> = {
        messages: [],
        draft: {},
        stage: "collecting",
        turnCount: 1,
        availableOptions: [],
        lastShownOptions: [],
        preferences: {},
        holdId: null,
        holdExpiresAt: null,
        bookingId: null,
      };

      const merged = service.mergeWithExisting(
        existingState,
        conversationId,
        "msg_new",
        "new",
        null,
      );

      expect(merged.response).toBeNull();
      expect(merged.outboxItems).toEqual([]);
      expect(merged.extraction).toBeNull();
      expect(merged.nextNode).toBeNull();
      expect(merged.error).toBeNull();
    });

    it("increments turn count", () => {
      const existingState: Partial<BookingAgentState> = {
        messages: [],
        draft: {},
        stage: "collecting",
        turnCount: 5,
        availableOptions: [],
        lastShownOptions: [],
        preferences: {},
        holdId: null,
        holdExpiresAt: null,
        bookingId: null,
      };

      const merged = service.mergeWithExisting(
        existingState,
        conversationId,
        "msg_1",
        "test",
        null,
      );

      expect(merged.turnCount).toBe(6);
    });
  });

  describe("addMessage", () => {
    it("adds user message to state", () => {
      const state = service.createInitialState(conversationId, "msg_1", "hi", null);

      service.addMessage(state, "user", "Hello there");

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].role).toBe("user");
      expect(state.messages[0].content).toBe("Hello there");
      expect(state.messages[0].timestamp).toBeDefined();
    });

    it("adds assistant message to state", () => {
      const state = service.createInitialState(conversationId, "msg_1", "hi", null);

      service.addMessage(state, "assistant", "How can I help?");

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].role).toBe("assistant");
      expect(state.messages[0].content).toBe("How can I help?");
    });

    it("trims messages beyond history limit", () => {
      const state = service.createInitialState(conversationId, "msg_1", "hi", null);

      for (let i = 0; i < 15; i++) {
        service.addMessage(state, i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
      }

      expect(state.messages).toHaveLength(10);
      expect(state.messages[0].content).toBe("Message 5");
      expect(state.messages[9].content).toBe("Message 14");
    });
  });

  describe("loadState", () => {
    it("returns null when no state exists", async () => {
      redisMock.get.mockResolvedValue(null);

      const state = await service.loadState(conversationId);

      expect(state).toBeNull();
      expect(redisMock.get).toHaveBeenCalledWith(stateKey);
    });

    it("returns parsed state when exists", async () => {
      const storedState = {
        messages: [],
        draft: { pickupLocation: "Ikeja" },
        stage: "collecting",
        turnCount: 1,
        availableOptions: [],
        lastShownOptions: [],
        preferences: {},
        holdId: null,
        holdExpiresAt: null,
        bookingId: null,
        updatedAt: new Date().toISOString(),
      };

      redisMock.get.mockResolvedValue(JSON.stringify(storedState));

      const state = await service.loadState(conversationId);

      expect(state).not.toBeNull();
      expect(state?.draft?.pickupLocation).toBe("Ikeja");
      expect(state?.stage).toBe("collecting");
    });

    it("throws on parse error", async () => {
      redisMock.get.mockResolvedValue("invalid json {{{");

      await expect(service.loadState(conversationId)).rejects.toThrow();
    });

    it("throws on redis error", async () => {
      redisMock.get.mockRejectedValue(new Error("Redis connection failed"));

      await expect(service.loadState(conversationId)).rejects.toThrow();
    });
  });

  describe("saveState", () => {
    it("saves state to redis with TTL", async () => {
      const state: BookingAgentState = {
        conversationId,
        inboundMessage: "test",
        inboundMessageId: "msg_1",
        customerId: null,
        stage: "collecting",
        turnCount: 1,
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
      };

      await service.saveState(conversationId, state);

      expect(redisMock.setex).toHaveBeenCalledWith(
        stateKey,
        expect.any(Number),
        expect.any(String),
      );
    });

    it("retries on failure", async () => {
      redisMock.setex.mockRejectedValueOnce(new Error("Timeout")).mockResolvedValueOnce("OK");

      const state: BookingAgentState = {
        conversationId,
        inboundMessage: "test",
        inboundMessageId: "msg_1",
        customerId: null,
        stage: "collecting",
        turnCount: 1,
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
      };

      await service.saveState(conversationId, state);

      expect(redisMock.setex).toHaveBeenCalledTimes(2);
    });

    it("throws after max retries", async () => {
      redisMock.setex.mockRejectedValue(new Error("Persistent failure"));

      const state: BookingAgentState = {
        conversationId,
        inboundMessage: "test",
        inboundMessageId: "msg_1",
        customerId: null,
        stage: "collecting",
        turnCount: 1,
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
      };

      await expect(service.saveState(conversationId, state)).rejects.toThrow();
      expect(redisMock.setex).toHaveBeenCalledTimes(3);
    });
  });

  describe("clearState", () => {
    it("deletes state from redis", async () => {
      await service.clearState(conversationId);

      expect(redisMock.del).toHaveBeenCalledWith(stateKey);
    });

    it("does not throw on redis error", async () => {
      redisMock.del.mockRejectedValue(new Error("Redis error"));

      await expect(service.clearState(conversationId)).resolves.not.toThrow();
    });
  });
});
