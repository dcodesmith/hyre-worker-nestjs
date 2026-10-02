import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppMessageKind } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { BookingAgentOrchestratorService } from "../src/modules/booking-agent/booking-agent-orchestrator.service";
import { BookingAgentExtractorService } from "../src/modules/booking-agent/conversation/booking-agent-extractor.service";
import { BookingAgentStateService } from "../src/modules/booking-agent/conversation/booking-agent-state.service";
import { BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE } from "../src/modules/booking-agent/conversation/conversation.const";
import type { BookingAgentState } from "../src/modules/booking-agent/conversation/conversation.interface";
import { BOOKING_AGENT_ANTHROPIC_CLIENT } from "../src/modules/booking-agent/conversation/conversation.tokens";
import { DatabaseService } from "../src/modules/database/database.service";
import { GooglePlacesService } from "../src/modules/maps/google-places.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Booking Agent", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let orchestratorService: BookingAgentOrchestratorService;
  let extractorService: { extract: ReturnType<typeof vi.fn> };
  let claudeService: { messages: { create: ReturnType<typeof vi.fn> } };
  let googlePlacesService: { validateAddress: ReturnType<typeof vi.fn> };
  let factory: TestDataFactory;
  let ownerId: string;
  const DAY_IN_MS = 24 * 60 * 60 * 1000;
  const TEST_BASE_DATE_UTC = Date.UTC(2099, 2, 1, 10, 0, 0);
  const generateFutureDate = (daysAhead: number): string =>
    new Date(TEST_BASE_DATE_UTC + daysAhead * DAY_IN_MS).toISOString().slice(0, 10);
  const generateFutureDateTime = (daysAhead: number): Date =>
    new Date(TEST_BASE_DATE_UTC + daysAhead * DAY_IN_MS);
  const FUTURE_PICKUP_DATE = generateFutureDate(6);
  const FUTURE_DROPOFF_DATE = generateFutureDate(11);
  const FUTURE_NEXT_DAY_DROPOFF_DATE = generateFutureDate(7);
  const FUTURE_THREE_DAY_DROPOFF_DATE = generateFutureDate(8);
  const FUTURE_LATER_PICKUP_DATE = generateFutureDate(9);
  const FUTURE_WINDOW_EXPIRES_AT = generateFutureDateTime(5);
  const FUTURE_LATER_WINDOW_EXPIRES_AT = generateFutureDateTime(8);

  const seedCar = async (
    overrides?: Parameters<TestDataFactory["createCar"]>[1],
  ): Promise<{ id: string }> => {
    const car = await factory.createCar(ownerId, overrides);
    if (overrides?.vehicleType || overrides?.serviceTier) {
      await databaseService.car.update({
        where: { id: car.id },
        data: {
          vehicleType: overrides.vehicleType,
          serviceTier: overrides.serviceTier,
        },
      });
    }
    await databaseService.vehicleImage.create({
      data: {
        carId: car.id,
        url: `https://cdn.tripdly.test/${car.id}.jpg`,
      },
    });
    return car;
  };

  const setDefaultValidateAddressMock = () => {
    googlePlacesService.validateAddress.mockImplementation(async (address: string) => ({
      isValid: true,
      normalizedAddress: address,
    }));
  };

  beforeAll(async () => {
    extractorService = {
      extract: vi.fn(),
    };

    claudeService = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Please share the missing booking details." }],
        }),
      },
    };

    googlePlacesService = {
      validateAddress: vi.fn(),
    };
    setDefaultValidateAddressMock();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(BookingAgentExtractorService)
      .useValue(extractorService)
      .overrideProvider(BOOKING_AGENT_ANTHROPIC_CLIENT)
      .useValue(claudeService)
      .overrideProvider(GooglePlacesService)
      .useValue(googlePlacesService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
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
        chauffeurApprovalStatus: "APPROVED",
        hasOnboarded: true,
        isOwnerDriver: true,
        emailVerified: true,
        phoneNumber: "+2348012345602",
        phoneVerifiedAt: new Date(),
      },
    });
  });

  beforeEach(async () => {
    await databaseService.car.deleteMany({ where: { ownerId } });
    extractorService.extract.mockReset();
    claudeService.messages.create.mockReset();
    claudeService.messages.create.mockResolvedValue({
      content: [{ type: "text", text: "Please share the missing booking details." }],
    });
    googlePlacesService.validateAddress.mockReset();
    setDefaultValidateAddressMock();
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
        pickupDate: FUTURE_PICKUP_DATE,
        dropoffDate: FUTURE_DROPOFF_DATE,
        pickupTime: "9:00 AM",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      preferenceHint: "show_alternatives",
      confidence: 0.95,
    });

    const result = await orchestratorService.decide({
      messageId: "msg_s1",
      conversationId: "conv_s1",
      body: "I need a black Toyota Prado from tomorrow for 5 days",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s1:intro");
    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Here are your options");
    expect(
      result.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("booking-agent:msg_s1:vehicle:"),
      ),
    ).toBe(true);
  });

  it("returns fallback unavailable message when extractor service is down", async () => {
    extractorService.extract.mockRejectedValueOnce(new Error("service unavailable"));

    const result = await orchestratorService.decide({
      messageId: "msg_outage_1",
      conversationId: "conv_outage_1",
      body: "I need a black Toyota Prado tomorrow",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
    expect(text).not.toContain("Here are your options");
    expect(extractorService.extract).toHaveBeenCalled();
    expect(claudeService.messages.create).not.toHaveBeenCalled();
    expect(googlePlacesService.validateAddress).not.toHaveBeenCalled();
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
        pickupDate: FUTURE_PICKUP_DATE,
        dropoffDate: FUTURE_NEXT_DAY_DROPOFF_DATE,
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
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s2");
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
          pickupDate: FUTURE_PICKUP_DATE,
          dropoffDate: FUTURE_THREE_DAY_DROPOFF_DATE,
        },
        confidence: 0.95,
      });

    const firstTurn = await orchestratorService.decide({
      messageId: "msg_s3_first",
      conversationId: "conv_s3",
      body: "I need a black Toyota SUV",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });
    expect(firstTurn.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s3_first");

    const secondTurn = await orchestratorService.decide({
      messageId: "msg_s3_second",
      conversationId: "conv_s3",
      body: "from tomorrow for 3 days",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    expect(secondTurn.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s3_second:intro");
    const text = secondTurn.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("Here are your options");
    expect(
      secondTurn.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("booking-agent:msg_s3_second:vehicle:"),
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
          pickupDate: FUTURE_PICKUP_DATE,
          dropoffDate: FUTURE_THREE_DAY_DROPOFF_DATE,
        },
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          pickupDate: FUTURE_PICKUP_DATE,
          dropoffDate: FUTURE_THREE_DAY_DROPOFF_DATE,
        },
        confidence: 0.95,
      });

    await orchestratorService.decide({
      messageId: "msg_s4_seed",
      conversationId: "conv_s4",
      body: `I need a black Toyota Prado from ${FUTURE_PICKUP_DATE}`,
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    const beforeResetFollowup = await orchestratorService.decide({
      messageId: "msg_s4_before_reset",
      conversationId: "conv_s4",
      body: `until ${FUTURE_THREE_DAY_DROPOFF_DATE}`,
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });
    expect(beforeResetFollowup.enqueueOutbox[0]?.dedupeKey).toBe(
      "booking-agent:msg_s4_before_reset:intro",
    );
    expect(beforeResetFollowup.enqueueOutbox[0]?.textBody ?? "").toContain("Here are your options");

    const reset = await orchestratorService.decide({
      messageId: "msg_s4",
      conversationId: "conv_s4",
      body: "start over",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    expect(reset.enqueueOutbox).toHaveLength(1);
    expect(reset.enqueueOutbox[0]?.dedupeKey).toBe("reset-ack:msg_s4");
    expect(reset.enqueueOutbox[0]?.textBody).toContain("reset");

    const afterResetFollowup = await orchestratorService.decide({
      messageId: "msg_s4_after_reset",
      conversationId: "conv_s4",
      body: `until ${FUTURE_THREE_DAY_DROPOFF_DATE}`,
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });
    expect(afterResetFollowup.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s4_after_reset");
    const afterResetText = afterResetFollowup.enqueueOutbox[0]?.textBody ?? "";
    expect(afterResetText).toContain("missing booking details");
    expect(
      afterResetFollowup.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("booking-agent:msg_s4_after_reset:vehicle:"),
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
        pickupDate: FUTURE_PICKUP_DATE,
        dropoffDate: FUTURE_THREE_DAY_DROPOFF_DATE,
        pickupTime: "25:99",
        pickupLocation: "Wheatbaker hotel, Ikoyi",
        dropoffLocation: "Wheatbaker hotel, Ikoyi",
      },
      confidence: 0.95,
    });

    const result = await orchestratorService.decide({
      messageId: "msg_s5",
      conversationId: "conv_s5",
      body: `I need a black Prado from tomorrow to ${FUTURE_THREE_DAY_DROPOFF_DATE} at 25:99`,
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s5");
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
          pickupDate: FUTURE_LATER_PICKUP_DATE,
          dropoffDate: FUTURE_DROPOFF_DATE,
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
      windowExpiresAt: FUTURE_LATER_WINDOW_EXPIRES_AT,
    });
    expect(firstTurn.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s6_first");
    expect(firstTurn.enqueueOutbox[0]?.textBody ?? "").toContain("missing booking details");

    const secondTurn = await orchestratorService.decide({
      messageId: "msg_s6_second",
      conversationId: "conv_s6",
      body: "DAY",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_LATER_WINDOW_EXPIRES_AT,
    });

    const secondTurnText = secondTurn.enqueueOutbox[0]?.textBody ?? "";
    expect(secondTurn.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s6_second:intro");
    expect(secondTurnText).toContain("Here are your options");
    expect(
      secondTurn.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("booking-agent:msg_s6_second:vehicle:"),
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
        pickupDate: FUTURE_LATER_PICKUP_DATE,
        dropoffDate: FUTURE_DROPOFF_DATE,
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
      windowExpiresAt: FUTURE_LATER_WINDOW_EXPIRES_AT,
    });

    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("booking-agent:msg_s7:intro");
    expect(text).toContain("Here are your options");
    expect(
      result.enqueueOutbox.some((item) =>
        item.dedupeKey.startsWith("booking-agent:msg_s7:vehicle:"),
      ),
    ).toBe(true);
  });

  it("preserves draft and options when extract fails on a later turn", async () => {
    await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      vehicleType: "SUV",
      dayRate: 65000,
      registrationNumber: "WA-OUTAGE-001",
    });

    extractorService.extract
      .mockResolvedValueOnce({
        intent: "provide_info",
        draftPatch: {
          make: "Toyota",
          model: "Prado",
          vehicleType: "SUV",
          color: "White",
          pickupDate: FUTURE_LATER_PICKUP_DATE,
          dropoffDate: FUTURE_DROPOFF_DATE,
          bookingType: "DAY",
          pickupTime: "9 AM",
          pickupLocation: "Wheatbaker hotel, Ikoyi",
          dropoffLocation: "Wheatbaker hotel, Ikoyi",
        },
        confidence: 0.95,
      })
      .mockRejectedValueOnce(new Error("service unavailable"));

    const firstTurn = await orchestratorService.decide({
      messageId: "msg_outage_preserve_1",
      conversationId: "conv_outage_preserve",
      body: "Book a white Prado day trip from Wheatbaker hotel, Ikoyi",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_LATER_WINDOW_EXPIRES_AT,
    });
    expect(firstTurn.enqueueOutbox[0]?.textBody ?? "").toContain("Here are your options");
    const claudeCallsBeforeOutage = claudeService.messages.create.mock.calls.length;

    const outageTurn = await orchestratorService.decide({
      messageId: "msg_outage_preserve_2",
      conversationId: "conv_outage_preserve",
      body: "the white one",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_LATER_WINDOW_EXPIRES_AT,
    });

    const outageText = outageTurn.enqueueOutbox.map((item) => item.textBody ?? "").join("\n");
    expect(outageText).toContain(BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE);
    expect(outageText).not.toContain("Here are your options");
    expect(claudeService.messages.create).toHaveBeenCalledTimes(claudeCallsBeforeOutage);

    const persisted = await app.get(BookingAgentStateService).loadState("conv_outage_preserve");
    expect(persisted?.draft.pickupLocation).toBe("Wheatbaker hotel, Ikoyi");
    expect(persisted?.availableOptions.length).toBeGreaterThan(0);
  });

  it("keeps paymentLink across a follow-up turn", async () => {
    const stateService = app.get(BookingAgentStateService);
    const paymentLink = "https://pay.example.com/invoice/phase1";
    const conversationId = "conv_payment_link_persist";
    const seeded: BookingAgentState = {
      messages: [],
      conversationId,
      customerId: null,
      inboundMessage: "confirm",
      inboundMessageId: "msg_payment_seed",
      draft: { pickupLocation: "Ikoyi" },
      stage: "awaiting_payment",
      turnCount: 3,
      extraction: null,
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: null,
      holdId: null,
      holdExpiresAt: null,
      bookingId: "booking_phase1",
      paymentLink,
      preferences: {},
      response: null,
      outboxItems: [],
      nextAction: null,
      error: null,
      statusMessage: null,
    };
    await stateService.saveState(conversationId, seeded);

    extractorService.extract.mockResolvedValue({
      intent: "ask_question",
      draftPatch: {},
      confidence: 0.8,
    });

    const followUp = await orchestratorService.decide({
      messageId: "msg_payment_followup",
      conversationId,
      body: "how do I pay?",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: FUTURE_WINDOW_EXPIRES_AT,
    });

    const followUpText = followUp.enqueueOutbox.map((item) => item.textBody ?? "").join("\n");
    expect(followUpText).not.toMatch(/HOLD ACTIVE/i);
    expect(followUpText).not.toMatch(/reserved/i);

    const persisted = await stateService.loadState(conversationId);
    expect(persisted?.paymentLink).toBe(paymentLink);
    expect(persisted?.bookingId).toBe("booking_phase1");
  });
});
