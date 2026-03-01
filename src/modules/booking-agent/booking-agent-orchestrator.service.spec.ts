import { Test, TestingModule } from "@nestjs/testing";
import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingAgentOrchestratorService } from "./booking-agent-orchestrator.service";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { LangGraphGraphService } from "./langgraph/langgraph-graph.service";
import { LangGraphStateService } from "./langgraph/langgraph-state.service";

describe("BookingAgentOrchestratorService", () => {
  let moduleRef: TestingModule;
  let service: BookingAgentOrchestratorService;
  let windowPolicyService: { resolveOutboundMode: ReturnType<typeof vi.fn> };
  let langGraphService: { invoke: ReturnType<typeof vi.fn> };
  let langGraphStateService: { clearState: ReturnType<typeof vi.fn> };

  const buildContext = (
    overrides?: Partial<Parameters<BookingAgentOrchestratorService["decide"]>[0]>,
  ) => ({
    messageId: "msg_1",
    conversationId: "conv_1",
    body: "Need an SUV tomorrow",
    kind: WhatsAppMessageKind.TEXT,
    windowExpiresAt: new Date("2026-02-26T12:00:00Z"),
    ...overrides,
  });

  beforeEach(async () => {
    windowPolicyService = {
      resolveOutboundMode: vi.fn().mockReturnValue(WhatsAppDeliveryMode.FREE_FORM),
    };
    langGraphService = {
      invoke: vi.fn(),
    };
    langGraphStateService = {
      clearState: vi.fn().mockResolvedValue(undefined),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        BookingAgentOrchestratorService,
        {
          provide: BookingAgentWindowPolicyService,
          useValue: windowPolicyService,
        },
        {
          provide: LangGraphGraphService,
          useValue: langGraphService,
        },
        {
          provide: LangGraphStateService,
          useValue: langGraphStateService,
        },
      ],
    }).compile();

    service = moduleRef.get(BookingAgentOrchestratorService);
  });

  it("routes explicit AGENT request to handoff", async () => {
    const result = await service.decide(buildContext({ body: "agent" }));

    expect(result.markAsHandoff).toEqual({ reason: "USER_REQUESTED_AGENT" });
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(langGraphService.invoke).not.toHaveBeenCalled();
  });

  it("returns media fallback for inbound audio/image/doc messages", async () => {
    const result = await service.decide(buildContext({ kind: WhatsAppMessageKind.AUDIO }));
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("media-fallback:msg_1");
    expect(langGraphService.invoke).not.toHaveBeenCalled();
  });

  it("clears langgraph state when user requests reset", async () => {
    const result = await service.decide(buildContext({ body: "start over" }));

    expect(langGraphStateService.clearState).toHaveBeenCalledWith("conv_1");
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("reset-ack:msg_1");
    expect(langGraphService.invoke).not.toHaveBeenCalled();
  });

  it("delegates normal text conversations to LangGraph", async () => {
    langGraphService.invoke.mockResolvedValue({
      outboxItems: [
        {
          conversationId: "conv_1",
          dedupeKey: "langgraph:outbox:1",
          mode: WhatsAppDeliveryMode.FREE_FORM,
          textBody: "Sure, let's continue your booking.",
        },
      ],
      response: { text: "Sure, let's continue your booking." },
      stage: "collecting",
      draft: {},
      error: null,
    });

    const result = await service.decide(buildContext({ body: "Need an SUV tomorrow" }));

    expect(langGraphService.invoke).toHaveBeenCalledWith({
      conversationId: "conv_1",
      messageId: "msg_1",
      message: "Need an SUV tomorrow",
      customerId: null,
      interactive: undefined,
    });
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:outbox:1");
  });

  it("returns fallback message when LangGraph invocation fails", async () => {
    langGraphService.invoke.mockRejectedValue(new Error("Graph failed"));

    const result = await service.decide(buildContext({ body: "Need an SUV" }));

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph-error:msg_1");
    expect(result.enqueueOutbox[0]?.textBody).toContain("I'm having trouble processing");
  });
});
