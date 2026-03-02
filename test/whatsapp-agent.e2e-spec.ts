import type { INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppMessageKind } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import type { AiSearchResponse } from "../src/modules/ai-search/ai-search.interface";
import { AiSearchService } from "../src/modules/ai-search/ai-search.service";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { BookingAgentOrchestratorService } from "../src/modules/booking-agent/booking-agent-orchestrator.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("WhatsApp Agent phase 2.1 scenarios (e2e)", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let orchestratorService: BookingAgentOrchestratorService;
  let aiSearchService: { search: ReturnType<typeof vi.fn> };
  let factory: TestDataFactory;
  let ownerId: string;

  const buildAiSearchResponse = (raw: AiSearchResponse["raw"]): AiSearchResponse => ({
    params: {},
    interpretation: "Search intent extracted",
    raw,
  });

  const seedCar = async (
    overrides?: Parameters<TestDataFactory["createCar"]>[1],
  ): Promise<{ id: string }> => {
    const car = await factory.createCar(ownerId, overrides);
    await databaseService.vehicleImage.create({
      data: {
        carId: car.id,
        url: `https://cdn.tripdly.test/${car.id}.jpg`,
      },
    });
    return car;
  };

  beforeAll(async () => {
    aiSearchService = {
      search: vi.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(AiSearchService)
      .useValue(aiSearchService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
    await app.init();

    databaseService = app.get(DatabaseService);
    orchestratorService = app.get(BookingAgentOrchestratorService);
    factory = new TestDataFactory(databaseService);

    const owner = await factory.createFleetOwner({ email: uniqueEmail("wa-agent-owner") });
    ownerId = owner.id;

    await databaseService.user.update({
      where: { id: ownerId },
      data: {
        fleetOwnerStatus: "APPROVED",
        hasOnboarded: true,
        isOwnerDriver: true,
      },
    });
  });

  beforeEach(async () => {
    await databaseService.car.deleteMany({ where: { ownerId } });
    aiSearchService.search.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it("Scenario 1: returns ranked alternatives and booking-type clarification when no exact match exists", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      dayRate: 65000,
      registrationNumber: "WA-S1-001",
    });
    await seedCar({
      make: "Toyota",
      model: "Land Cruiser",
      color: "Black",
      dayRate: 75000,
      registrationNumber: "WA-S1-002",
    });
    await seedCar({
      make: "Lexus",
      model: "GX 460",
      color: "Black",
      dayRate: 70000,
      registrationNumber: "WA-S1-003",
    });

    aiSearchService.search.mockResolvedValue(
      buildAiSearchResponse({
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        from: "2026-03-07",
        to: "2026-03-12",
      }),
    );

    const result = await orchestratorService.decide({
      messageId: "msg_s1",
      conversationId: "conv_s1",
      body: "I need a black Toyota Prado from tomorrow for 5 days",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s1");
    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Lang Graph Extraction Failed Exception");
  });

  it("Scenario 2: asks booking-type clarification after listing close category alternatives", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      vehicleType: "SUV",
      registrationNumber: "WA-S2-001",
    });
    await seedCar({
      make: "Mercedes",
      model: "GLE",
      color: "Black",
      vehicleType: "SUV",
      dayRate: 95000,
      registrationNumber: "WA-S2-002",
    });

    aiSearchService.search.mockResolvedValue(
      buildAiSearchResponse({
        vehicleType: "SUV",
        from: "2026-03-07",
        to: "2026-03-08",
      }),
    );

    const result = await orchestratorService.decide({
      messageId: "msg_s2",
      conversationId: "conv_s2",
      body: "Book me an SUV for next weekend",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s2");
    expect(text).toContain("Lang Graph Extraction Failed Exception");
  });

  it("Scenario 3: carries slot context across turns when follow-up provides only dates", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "Black",
      vehicleType: "SUV",
      dayRate: 65000,
      registrationNumber: "WA-S3-001",
    });

    aiSearchService.search
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          make: "Toyota",
          color: "Black",
          vehicleType: "SUV",
        }),
      )
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          from: "2026-03-07",
          to: "2026-03-09",
        }),
      );

    const firstTurn = await orchestratorService.decide({
      messageId: "msg_s3_first",
      conversationId: "conv_s3",
      body: "I need a black Toyota SUV",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });
    expect(firstTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s3_first");

    const secondTurn = await orchestratorService.decide({
      messageId: "msg_s3_second",
      conversationId: "conv_s3",
      body: "from tomorrow for 3 days",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(secondTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s3_second");
    const text = secondTurn.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Lang Graph Extraction Failed Exception");
  });

  it("Scenario 4: reset command clears slot memory and asks for a new request", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "Black",
      vehicleType: "SUV",
      dayRate: 65000,
      registrationNumber: "WA-S4-001",
    });

    aiSearchService.search
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          make: "Toyota",
          model: "Prado",
          color: "Black",
          from: "2026-03-07",
        }),
      )
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          to: "2026-03-09",
        }),
      )
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          to: "2026-03-09",
        }),
      );

    await orchestratorService.decide({
      messageId: "msg_s4_seed",
      conversationId: "conv_s4",
      body: "I need a black Toyota Prado from 2026-03-07",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    const beforeResetFollowup = await orchestratorService.decide({
      messageId: "msg_s4_before_reset",
      conversationId: "conv_s4",
      body: "until 2026-03-09",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });
    expect(beforeResetFollowup.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s4_before_reset");
    expect(beforeResetFollowup.enqueueOutbox[0]?.textBody ?? "").toContain(
      "Lang Graph Extraction Failed Exception",
    );

    const reset = await orchestratorService.decide({
      messageId: "msg_s4",
      conversationId: "conv_s4",
      body: "start over",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(reset.enqueueOutbox).toHaveLength(1);
    expect(reset.enqueueOutbox[0]?.dedupeKey).toBe("reset-ack:msg_s4");
    expect(reset.enqueueOutbox[0]?.textBody).toContain("reset");

    const afterResetFollowup = await orchestratorService.decide({
      messageId: "msg_s4_after_reset",
      conversationId: "conv_s4",
      body: "until 2026-03-09",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });
    expect(afterResetFollowup.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s4_after_reset");
    const afterResetText = afterResetFollowup.enqueueOutbox[0]?.textBody ?? "";
    expect(afterResetText).toContain("Lang Graph Extraction Failed Exception");
  });

  it("Scenario 5: enforces hard precondition when pickup date is missing", async () => {
    aiSearchService.search.mockResolvedValue(
      buildAiSearchResponse({
        make: "Toyota",
        model: "Prado",
        color: "Black",
      }),
    );

    const result = await orchestratorService.decide({
      messageId: "msg_s5",
      conversationId: "conv_s5",
      body: "I need a black Prado",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s5");
    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Lang Graph Extraction Failed Exception");
  });

  it("Scenario 6: booking type confirmation does not loop after clarification prompt", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      vehicleType: "SUV",
      dayRate: 65000,
      registrationNumber: "WA-S6-001",
    });

    aiSearchService.search
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          make: "Toyota",
          vehicleType: "SUV",
          color: "White",
          from: "2026-03-10",
          to: "2026-03-12",
          pickupTime: "9 AM",
          pickupLocation: "Wheatbaker hotel, Ikoyi",
          dropoffLocation: "Wheatbaker hotel, Ikoyi",
        }),
      )
      .mockResolvedValueOnce(
        buildAiSearchResponse({
          bookingType: "DAY",
        }),
      );

    const firstTurn = await orchestratorService.decide({
      messageId: "msg_s6_first",
      conversationId: "conv_s6",
      body: "I'd like to book a white Toyota SUV for 2 days from tomorrow starting at 9am, pick up and drop off at Wheatbaker hotel, Ikoyi",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-09T10:00:00Z"),
    });
    expect(firstTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s6_first");

    const secondTurn = await orchestratorService.decide({
      messageId: "msg_s6_second",
      conversationId: "conv_s6",
      body: "DAY",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-09T10:00:00Z"),
    });

    const secondTurnText = secondTurn.enqueueOutbox[0]?.textBody ?? "";
    expect(secondTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s6_second");
    expect(secondTurnText).toContain("Lang Graph Extraction Failed Exception");
    expect(secondTurnText).not.toContain("Reply with DAY, NIGHT, or FULL_DAY.");
  });

  it("Scenario 7: explicit DAY booking type in first message goes straight to options", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      vehicleType: "SUV",
      dayRate: 65000,
      registrationNumber: "WA-S7-001",
    });

    aiSearchService.search.mockResolvedValue(
      buildAiSearchResponse({
        make: "Toyota",
        vehicleType: "SUV",
        color: "White",
        from: "2026-03-10",
        to: "2026-03-12",
        bookingType: "DAY",
        pickupTime: "9 AM",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      }),
    );

    const result = await orchestratorService.decide({
      messageId: "msg_s7",
      conversationId: "conv_s7",
      body: "I'd like to book a white Toyota SUV for 2 days from tomorrow starting at 9am, day booking type, pick up and drop off at Wheatbaker hotel, Ikoyi",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-09T10:00:00Z"),
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s7");
    expect(text).toContain("Lang Graph Extraction Failed Exception");
    expect(text).not.toContain("Reply with DAY, NIGHT, or FULL_DAY.");
  });
});
