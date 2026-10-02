import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import type { PublicAddon } from "../../addons/addons.interface";
import { AddonsService } from "../../addons/addons.service";
import { BookingPricingPreviewService } from "../../booking/booking-pricing-preview.service";
import { WhatsAppPersistenceService } from "../whatsapp/whatsapp-persistence.service";
import { buildPricingPreview, buildState, buildVehicleOption } from "./conversation.factory";
import { PrepareQuoteAction } from "./prepare-quote.action";

const wifi: PublicAddon = {
  id: "addon-wifi",
  code: "WIFI",
  name: "Wi-Fi",
  description: "Mobile hotspot",
  pricingUnit: "PER_BOOKING",
  unitPrice: 5000,
  currency: "NGN",
};

const childSeat: PublicAddon = {
  id: "addon-seat",
  code: "SEAT",
  name: "Child seat",
  description: null,
  pricingUnit: "PER_LEG",
  unitPrice: 3000,
  currency: "NGN",
};

const readyDraft = {
  bookingType: "DAY" as const,
  pickupDate: "2026-03-01",
  pickupTime: "09:00",
  dropoffDate: "2026-03-01",
  pickupLocation: "Victoria Island",
  dropoffLocation: "Lekki",
  notes: "Please arrive 10 minutes early",
};

describe("PrepareQuoteAction", () => {
  let action: PrepareQuoteAction;
  let addonsService: { listPublic: ReturnType<typeof vi.fn> };
  let pricingPreviewService: { preview: ReturnType<typeof vi.fn> };
  let persistenceService: { getConversationLinkState: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    addonsService = { listPublic: vi.fn().mockResolvedValue({ addons: [wifi, childSeat] }) };
    pricingPreviewService = { preview: vi.fn().mockResolvedValue(buildPricingPreview()) };
    persistenceService = {
      getConversationLinkState: vi
        .fn()
        .mockResolvedValue({ linkedUserId: null, linkStatus: "UNLINKED" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrepareQuoteAction,
        { provide: AddonsService, useValue: addonsService },
        { provide: BookingPricingPreviewService, useValue: pricingPreviewService },
        { provide: WhatsAppPersistenceService, useValue: persistenceService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    action = module.get(PrepareQuoteAction);
  });

  it("asks for a vehicle before pricing", async () => {
    await expect(
      action.run(buildState({ stage: "selecting_addons", draft: readyDraft })),
    ).resolves.toEqual({
      error: "Choose a vehicle before reviewing the final quote.",
      stage: "collecting",
    });
    expect(addonsService.listPublic).not.toHaveBeenCalled();
  });

  it("loads public add-ons for the booking type and offers the first one", async () => {
    const result = await action.run(
      buildState({
        stage: "selecting_addons",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
      }),
    );

    expect(addonsService.listPublic).toHaveBeenCalledWith("DAY");
    expect(result).toEqual({
      availableAddons: [wifi, childSeat],
      stage: "selecting_addons",
    });
    expect(pricingPreviewService.preview).not.toHaveBeenCalled();
  });

  it("keeps the current add-on list instead of reloading it", async () => {
    const result = await action.run(
      buildState({
        stage: "selecting_addons",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [wifi],
        addonSelectionIndex: 0,
      }),
    );

    expect(addonsService.listPublic).not.toHaveBeenCalled();
    expect(result.availableAddons).toEqual([wifi]);
    expect(result.stage).toBe("selecting_addons");
  });

  it("offers fuel after the last add-on when the upgrade has a cost", async () => {
    const fuelPreview = buildPricingPreview({ fuelUpgradeCost: 8000, totalAmount: 158000 });
    pricingPreviewService.preview.mockResolvedValue(fuelPreview);

    const result = await action.run(
      buildState({
        stage: "selecting_addons",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [wifi],
        selectedAddonIds: [wifi.id],
        addonSelectionIndex: 1,
      }),
    );

    expect(pricingPreviewService.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        addonIds: [wifi.id],
        requiresFullTank: true,
        useCredits: 0,
      }),
      null,
    );
    expect(result).toEqual({
      availableAddons: [wifi],
      pricingPreview: fuelPreview,
      stage: "selecting_fuel",
    });
  });

  it("confirms an unlinked quote when there is no fuel upgrade", async () => {
    addonsService.listPublic.mockResolvedValue({ addons: [] });
    const preview = buildPricingPreview({ totalAmount: 150000 });
    pricingPreviewService.preview.mockResolvedValue(preview);

    const result = await action.run(
      buildState({
        stage: "selecting_addons",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [],
        addonSelectionIndex: 0,
      }),
    );

    expect(result).toEqual({
      availableAddons: [],
      pricingPreview: preview,
      useCredits: 0,
      stage: "confirming",
    });
  });

  it("offers the linked account's applicable credits without a custom amount", async () => {
    addonsService.listPublic.mockResolvedValue({ addons: [] });
    persistenceService.getConversationLinkState.mockResolvedValue({
      linkedUserId: "user-1",
      linkStatus: "LINKED",
    });
    const preview = buildPricingPreview({ creditsApplicable: 4000, totalAmount: 150000 });
    pricingPreviewService.preview.mockResolvedValue(preview);

    const result = await action.run(
      buildState({
        stage: "selecting_addons",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [],
      }),
    );

    expect(pricingPreviewService.preview).toHaveBeenCalledWith(expect.any(Object), {
      id: "user-1",
    });
    expect(result).toEqual({
      availableAddons: [],
      pricingPreview: preview,
      useCredits: 0,
      stage: "selecting_credits",
    });
  });

  it("prices the chosen fuel decision and confirms when the account is unlinked", async () => {
    const preview = buildPricingPreview({
      fuelUpgradeCost: 8000,
      totalAmount: 158000,
      creditsApplicable: 0,
    });
    pricingPreviewService.preview.mockResolvedValue(preview);

    const result = await action.run(
      buildState({
        stage: "selecting_fuel",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [wifi],
        requiresFullTank: false,
      }),
    );

    expect(pricingPreviewService.preview).toHaveBeenCalledWith(
      expect.objectContaining({ requiresFullTank: false, useCredits: 0 }),
      null,
    );
    expect(result.stage).toBe("confirming");
    expect(result.pricingPreview).toEqual(preview);
    expect(result.useCredits).toBe(0);
  });

  it("applies the exact linked credit balance when the customer accepts credits", async () => {
    persistenceService.getConversationLinkState.mockResolvedValue({
      linkedUserId: "user-1",
      linkStatus: "LINKED",
    });
    const preview = buildPricingPreview({
      creditsApplicable: 4000,
      creditsUsed: 4000,
      totalAmount: 146000,
    });
    pricingPreviewService.preview.mockResolvedValue(preview);

    const result = await action.run(
      buildState({
        stage: "selecting_credits",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [wifi],
        requiresFullTank: true,
        useCredits: 4000,
      }),
    );

    expect(pricingPreviewService.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresFullTank: true,
        useCredits: 4000,
        addonIds: [],
      }),
      { id: "user-1" },
    );
    expect(result).toEqual({
      pricingPreview: preview,
      stage: "confirming",
    });
  });

  it("rebuilds a missing quote while remaining in the confirming stage", async () => {
    const preview = buildPricingPreview({ totalAmount: 150000 });
    pricingPreviewService.preview.mockResolvedValue(preview);

    const result = await action.run(
      buildState({
        stage: "confirming",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        pricingPreview: null,
        requiresFullTank: false,
        useCredits: 1000,
      }),
    );

    expect(pricingPreviewService.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresFullTank: false,
        useCredits: 1000,
      }),
      null,
    );
    expect(result).toEqual({
      pricingPreview: preview,
      stage: "confirming",
    });
  });

  it("returns a confirming error when pricing fails", async () => {
    addonsService.listPublic.mockResolvedValue({ addons: [] });
    pricingPreviewService.preview.mockRejectedValue(new Error("pricing down"));

    const result = await action.run(
      buildState({
        stage: "selecting_addons",
        draft: readyDraft,
        selectedOption: buildVehicleOption(),
        availableAddons: [],
      }),
    );

    expect(result).toEqual({
      error: "I couldn't prepare the final quote. Please try again or ask for an agent.",
      stage: "confirming",
    });
  });
});
