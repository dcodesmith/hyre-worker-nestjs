import { Test, TestingModule } from "@nestjs/testing";
import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { BookingAgentOrchestratorService } from "./booking-agent-orchestrator.service";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { BookingAgentStateService } from "./conversation/booking-agent-state.service";
import { BookingAgentTurnService } from "./conversation/booking-agent-turn.service";

describe("BookingAgentOrchestratorService", () => {
  let moduleRef: TestingModule;
  let service: BookingAgentOrchestratorService;
  let windowPolicyService: { resolveOutboundMode: ReturnType<typeof vi.fn> };
  let bookingAgentService: { invoke: ReturnType<typeof vi.fn> };
  let bookingAgentStateService: { clearState: ReturnType<typeof vi.fn> };

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
    bookingAgentService = {
      invoke: vi.fn(),
    };
    bookingAgentStateService = {
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
          provide: BookingAgentTurnService,
          useValue: bookingAgentService,
        },
        {
          provide: BookingAgentStateService,
          useValue: bookingAgentStateService,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = moduleRef.get(BookingAgentOrchestratorService);
  });

  it("routes explicit AGENT request to handoff", async () => {
    const result = await service.decide(buildContext({ body: "agent" }));

    expect(result.markAsHandoff).toEqual({ reason: "USER_REQUESTED_AGENT" });
    expect(result.enqueueOutbox).toHaveLength(1);
    expect(bookingAgentService.invoke).not.toHaveBeenCalled();
  });

  it("returns media fallback for inbound audio/image/doc messages", async () => {
    const result = await service.decide(buildContext({ kind: WhatsAppMessageKind.AUDIO }));
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("media-fallback:msg_1");
    expect(bookingAgentService.invoke).not.toHaveBeenCalled();
  });

  it("clears booking-agent state when user requests reset", async () => {
    const result = await service.decide(buildContext({ body: "start over" }));

    expect(bookingAgentStateService.clearState).toHaveBeenCalledWith("conv_1");
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("reset-ack:msg_1");
    expect(bookingAgentService.invoke).not.toHaveBeenCalled();
  });

  it("marks conversation as handoff when BookingAgent returns handoff outbox", async () => {
    bookingAgentService.invoke.mockResolvedValue({
      outboxItems: [
        {
          conversationId: "conv_1",
          dedupeKey: "booking-agent:handoff:msg_1",
          mode: WhatsAppDeliveryMode.FREE_FORM,
          textBody:
            "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
        },
      ],
      response: {
        text: "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
      },
      stage: "cancelled",
      draft: {},
      error: null,
    });

    const result = await service.decide(buildContext({ body: "talk to agent" }));

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:handoff:msg_1");
    expect(result.markAsHandoff).toEqual({ reason: "USER_REQUESTED_AGENT" });
  });

  it("returns fallback message when booking-agent turn fails", async () => {
    bookingAgentService.invoke.mockRejectedValue(new Error("Graph failed"));

    const result = await service.decide(buildContext({ body: "Need an SUV" }));

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent-error:msg_1");
    expect(result.enqueueOutbox[0]?.textBody).toContain("I'm having trouble processing");
  });

  it("keeps TEMPLATE mode for a valid HX content sid", async () => {
    bookingAgentService.invoke.mockResolvedValue({
      outboxItems: [
        {
          conversationId: "conv_1",
          dedupeKey: "booking-agent:msg_1:vehicle:0",
          mode: WhatsAppDeliveryMode.FREE_FORM,
          templateName: "HX43448303892f9f4026057adb597e0c22",
          templateVariables: { "1": "Toyota Prado" },
        },
      ],
      response: { text: "Here are your options" },
      stage: "presenting_options",
      draft: {},
      error: null,
    });

    const result = await service.decide(buildContext());

    expect(result.enqueueOutbox[0]?.mode).toBe(WhatsAppDeliveryMode.TEMPLATE);
    expect(result.enqueueOutbox[0]?.templateName).toBe("HX43448303892f9f4026057adb597e0c22");
    expect(windowPolicyService.resolveOutboundMode).not.toHaveBeenCalled();
  });

  it("strips invalid template names and never enqueues TEMPLATE without an HX SID", async () => {
    windowPolicyService.resolveOutboundMode.mockReturnValue(WhatsAppDeliveryMode.TEMPLATE);
    bookingAgentService.invoke.mockResolvedValue({
      outboxItems: [
        {
          conversationId: "conv_1",
          dedupeKey: "booking-agent:msg_1",
          mode: WhatsAppDeliveryMode.TEMPLATE,
          textBody: "Welcome back",
          templateName: "booking-reopen",
        },
        {
          conversationId: "conv_1",
          dedupeKey: "booking-agent:handoff:msg_1",
          mode: WhatsAppDeliveryMode.TEMPLATE,
          textBody: "An agent will join shortly",
          templateName: "handoff-reopen",
        },
      ],
      response: { text: "Welcome back" },
      stage: "collecting",
      draft: {},
      error: null,
    });

    const result = await service.decide(buildContext({ windowExpiresAt: null }));

    expect(windowPolicyService.resolveOutboundMode).toHaveBeenCalledWith(null);
    expect(result.enqueueOutbox).toEqual([
      expect.objectContaining({
        dedupeKey: "booking-agent:msg_1",
        mode: WhatsAppDeliveryMode.FREE_FORM,
        templateName: undefined,
      }),
      expect.objectContaining({
        dedupeKey: "booking-agent:handoff:msg_1",
        mode: WhatsAppDeliveryMode.FREE_FORM,
        templateName: undefined,
      }),
    ]);
    expect(result.enqueueOutbox.map((item) => item.templateName)).not.toEqual(
      expect.arrayContaining(["booking-reopen", "handoff-reopen"]),
    );
  });
});
