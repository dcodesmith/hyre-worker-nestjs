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
import { DatabaseService } from "../src/modules/database/database.service";
import { WhatsAppOrchestratorService } from "../src/modules/whatsapp-agent/whatsapp-orchestrator.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("WhatsApp Agent phase 2.1 scenarios (e2e)", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let orchestratorService: WhatsAppOrchestratorService;
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
    orchestratorService = app.get(WhatsAppOrchestratorService);
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
    const pradoWhite = await seedCar({
      make: "Toyota",
      model: "Prado",
      color: "White",
      dayRate: 65000,
      registrationNumber: "WA-S1-001",
    });
    const landCruiserBlack = await seedCar({
      make: "Toyota",
      model: "Land Cruiser",
      color: "Black",
      dayRate: 75000,
      registrationNumber: "WA-S1-002",
    });
    const lexusBlack = await seedCar({
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

    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("options-list:msg_s1");
    const text = result.enqueueOutbox[0]?.textBody ?? "";
    expect(text).toContain("No exact");
    expect(text).toContain("Toyota Prado");
    expect(text).toContain("Land Cruiser");
    expect(text).toContain("Lexus GX 460");
    expect(text).toContain("Reply with DAY, NIGHT, or FULL_DAY.");

    const imageKeys = result.enqueueOutbox.map((entry) => entry.dedupeKey);
    expect(imageKeys).toContain(`option-image:msg_s1:${pradoWhite.id}`);
    expect(imageKeys).toContain(`option-image:msg_s1:${landCruiserBlack.id}`);
    expect(imageKeys).toContain(`option-image:msg_s1:${lexusBlack.id}`);
  });

  it("Scenario 2: asks booking-type clarification after listing exact category matches", async () => {
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
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("options-list:msg_s2");
    expect(text).toContain("Available options");
    expect(text).toContain("Toyota Prado");
    expect(text).toContain("Mercedes GLE");
    expect(text).toContain("Reply with DAY, NIGHT, or FULL_DAY.");
  });

  it("enforces hard precondition when pickup date is missing", async () => {
    aiSearchService.search.mockResolvedValue(
      buildAiSearchResponse({
        make: "Toyota",
        model: "Prado",
        color: "Black",
      }),
    );

    const result = await orchestratorService.decide({
      messageId: "msg_s3",
      conversationId: "conv_s3",
      body: "I need a black Prado",
      kind: WhatsAppMessageKind.TEXT,
      windowExpiresAt: new Date("2026-03-06T10:00:00Z"),
    });

    expect(result.enqueueOutbox).toHaveLength(1);
    expect(result.enqueueOutbox[0]?.dedupeKey).toBe("collect-precondition:msg_s3:from");
    expect(result.enqueueOutbox[0]?.textBody).toContain("What date should pickup start?");
  });
});
