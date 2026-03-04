import type { INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppMessageKind } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { BookingAgentOrchestratorService } from "../src/modules/booking-agent/booking-agent-orchestrator.service";
import { LANGGRAPH_ANTHROPIC_CLIENT } from "../src/modules/booking-agent/langgraph/langgraph.tokens";
import { LangGraphExtractorService } from "../src/modules/booking-agent/langgraph/langgraph-extractor.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { GooglePlacesService } from "../src/modules/maps/google-places.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Booking Agent", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let orchestratorService: BookingAgentOrchestratorService;
  let extractorService: { extract: ReturnType<typeof vi.fn> };
  let claudeService: { invoke: ReturnType<typeof vi.fn> };
  let googlePlacesService: { validateAddressWithSuggestions: ReturnType<typeof vi.fn> };
  let factory: TestDataFactory;
  let ownerId: string;

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
    extractorService = {
      extract: vi.fn(),
    };

    claudeService = {
      invoke: vi.fn().mockResolvedValue({ content: "Please share the missing booking details." }),
    };

    googlePlacesService = {
      validateAddressWithSuggestions: vi.fn(),
    };

    googlePlacesService.validateAddressWithSuggestions.mockImplementation(
      async (address: string) => ({
        isValid: true,
        normalizedAddress: address,
        suggestions: [],
      }),
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(LangGraphExtractorService)
      .useValue(extractorService)
      .overrideProvider(LANGGRAPH_ANTHROPIC_CLIENT)
      .useValue(claudeService)
      .overrideProvider(GooglePlacesService)
      .useValue(googlePlacesService)
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
    extractorService.extract.mockReset();
    claudeService.invoke.mockReset();
    claudeService.invoke.mockResolvedValue({
      content: "Please share the missing booking details.",
    });
    googlePlacesService.validateAddressWithSuggestions.mockReset();
    googlePlacesService.validateAddressWithSuggestions.mockImplementation(
      async (address: string) => ({
        isValid: true,
        normalizedAddress: address,
        suggestions: [],
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("Scenario 1: returns ranked alternatives when no exact match exists", async () => {
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

    extractorService.extract.mockResolvedValue({
      intent: "provide_info",
      draftPatch: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        bookingType: "DAY",
        pickupDate: "2026-03-07",
        dropoffDate: "2026-03-12",
        pickupTime: "9:00 AM",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      confidence: 0.95,
    });

    const result = await orchestratorService.decide({
      messageId: "msg_s1",
      conversationId: "conv_s1",
      body: "I need a black Toyota Prado from tomorrow for 5 days",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s1:intro");
    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Here are your options");
    expect(
      result.enqueueOutbox.some((item) => item.dedupeKey.startsWith("langgraph:msg_s1:vehicle:")),
    ).toBe(true);
  });

  it("Scenario 2: asks for booking type when all other required fields are present", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      vehicleType: "SUV",
      registrationNumber: "WA-S2-001",
    });
    extractorService.extract.mockResolvedValue({
      intent: "provide_info",
      draftPatch: {
        make: "Toyota",
        model: "Prado",
        color: "White",
        vehicleType: "SUV",
        pickupDate: "2026-03-07",
        dropoffDate: "2026-03-08",
        pickupTime: "9:00 AM",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      confidence: 0.95,
    });

    const result = await orchestratorService.decide({
      messageId: "msg_s2",
      conversationId: "conv_s2",
      body: "Book me an SUV for next weekend",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s2");
    expect(text).toContain("missing booking details");
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

    extractorService.extract
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          make: "Toyota",
          model: "Prado",
          color: "Black",
          vehicleType: "SUV",
          bookingType: "DAY",
          pickupTime: "9:00 AM",
          pickupLocation: "Wheatbaker hotel, Ikoyi",
          dropoffLocation: "Wheatbaker hotel, Ikoyi",
        },
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          pickupDate: "2026-03-07",
          dropoffDate: "2026-03-09",
        },
        confidence: 0.95,
      });

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

    expect(secondTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s3_second:intro");
    const text = secondTurn.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Here are your options");
    expect(
      secondTurn.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("langgraph:msg_s3_second:vehicle:"),
      ),
    ).toBe(true);
  });

  it("Scenario 4: reset command clears slot memory before follow-up", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "Black",
      vehicleType: "SUV",
      dayRate: 65000,
      registrationNumber: "WA-S4-001",
    });

    extractorService.extract
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          make: "Toyota",
          model: "Prado",
          color: "Black",
          vehicleType: "SUV",
          bookingType: "DAY",
          pickupTime: "9:00 AM",
          pickupLocation: "Wheatbaker hotel, Ikoyi",
          dropoffLocation: "Wheatbaker hotel, Ikoyi",
        },
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          pickupDate: "2026-03-07",
          dropoffDate: "2026-03-09",
        },
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          pickupDate: "2026-03-07",
          dropoffDate: "2026-03-09",
        },
        confidence: 0.95,
      });

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
    expect(beforeResetFollowup.enqueueOutbox[0]?.dedupeKey).toBe(
      "langgraph:msg_s4_before_reset:intro",
    );
    expect(beforeResetFollowup.enqueueOutbox[0]?.textBody ?? "").toContain("Here are your options");

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
    expect(afterResetText).toContain("missing booking details");
    expect(
      afterResetFollowup.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("langgraph:msg_s4_after_reset:vehicle:"),
      ),
    ).toBe(false);
  });

  it("Scenario 5: enforces hard precondition when pickup time format is invalid", async () => {
    extractorService.extract.mockResolvedValue({
      intent: "provide_info",
      draftPatch: {
        make: "Toyota",
        model: "Prado",
        color: "Black",
        vehicleType: "SUV",
        bookingType: "DAY",
        pickupDate: "2026-03-07",
        dropoffDate: "2026-03-09",
        pickupTime: "25:99",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      confidence: 0.95,
    });

    const result = await orchestratorService.decide({
      messageId: "msg_s5",
      conversationId: "conv_s5",
      body: "I need a black Prado from tomorrow to 2026-03-09 at 25:99",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s5");
    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Please share pickup time in this format");
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

    extractorService.extract
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          make: "Toyota",
          model: "Prado",
          vehicleType: "SUV",
          color: "White",
          pickupDate: "2026-03-10",
          dropoffDate: "2026-03-12",
          pickupTime: "9 AM",
          pickupLocation: "Wheatbaker hotel, Ikoyi",
          dropoffLocation: "Wheatbaker hotel, Ikoyi",
        },
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          bookingType: "DAY",
        },
        confidence: 0.95,
      });

    const firstTurn = await orchestratorService.decide({
      messageId: "msg_s6_first",
      conversationId: "conv_s6",
      body: "I'd like to book a white Toyota SUV for 2 days from tomorrow starting at 9am, pick up and drop off at Wheatbaker hotel, Ikoyi",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-09T10:00:00Z"),
    });
    expect(firstTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s6_first");
    expect(firstTurn.enqueueOutbox[0]?.textBody ?? "").toContain("missing booking details");

    const secondTurn = await orchestratorService.decide({
      messageId: "msg_s6_second",
      conversationId: "conv_s6",
      body: "DAY",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-09T10:00:00Z"),
    });

    const secondTurnText = secondTurn.enqueueOutbox[0]?.textBody ?? "";
    expect(secondTurn.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s6_second:intro");
    expect(secondTurnText).toContain("Here are your options");
    expect(
      secondTurn.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("langgraph:msg_s6_second:vehicle:"),
      ),
    ).toBe(true);
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

    extractorService.extract.mockResolvedValue({
      intent: "provide_info",
      draftPatch: {
        make: "Toyota",
        model: "Prado",
        vehicleType: "SUV",
        color: "White",
        pickupDate: "2026-03-10",
        dropoffDate: "2026-03-12",
        bookingType: "DAY",
        pickupTime: "9 AM",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      confidence: 0.95,
    });

    const result = await orchestratorService.decide({
      messageId: "msg_s7",
      conversationId: "conv_s7",
      body: "I'd like to book a white Toyota SUV for 2 days from tomorrow starting at 9am, day booking type, pick up and drop off at Wheatbaker hotel, Ikoyi",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-09T10:00:00Z"),
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("langgraph:msg_s7:intro");
    expect(text).toContain("Here are your options");
    expect(
      result.enqueueOutbox.some((item) => item.dedupeKey.startsWith("langgraph:msg_s7:vehicle:")),
    ).toBe(true);
  });
});
