import { Test, type TestingModule } from "@nestjs/testing";
import { BookingType, ReferralIncentiveType, ReferralProgramStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { AdminReferralProgramController } from "./admin-referral-program.controller";
import type { CreateReferralProgramDto } from "./dto/referral-program.dto";
import { ReferralProgramService } from "./referral-program.service";

const adminUser = { id: "admin-1" } as AuthSession["user"];

const createDto: CreateReferralProgramDto = {
  refereeDiscount: { type: ReferralIncentiveType.FIXED, amount: 10000 },
  referrerReward: { type: ReferralIncentiveType.FIXED, amount: 2500 },
  minimumBookingAmount: 20000,
  eligibleBookingTypes: [BookingType.DAY],
  referralValidityDays: 30,
  maxCreditsPerBookingAmount: 30000,
  maxCreditsPerBookingPercent: 50,
};

describe("AdminReferralProgramController", () => {
  let controller: AdminReferralProgramController;
  let referralProgramService: {
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    referralProgramService = {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      history: vi.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminReferralProgramController],
      providers: [{ provide: ReferralProgramService, useValue: referralProgramService }],
    })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AdminReferralProgramController);
  });

  it("passes the actor id when creating a programme", async () => {
    referralProgramService.create.mockResolvedValue({ id: "default" });

    await expect(controller.create(createDto, adminUser)).resolves.toEqual({ id: "default" });
    expect(referralProgramService.create).toHaveBeenCalledWith(createDto, "admin-1");
  });

  it("delegates get to the service", async () => {
    referralProgramService.get.mockResolvedValue({ status: ReferralProgramStatus.ACTIVE });

    await expect(controller.get()).resolves.toEqual({ status: ReferralProgramStatus.ACTIVE });
  });

  it("passes the actor id when pausing or editing", async () => {
    const dto = { status: ReferralProgramStatus.PAUSED };
    referralProgramService.update.mockResolvedValue({ status: ReferralProgramStatus.PAUSED });

    await expect(controller.update(dto, adminUser)).resolves.toEqual({
      status: ReferralProgramStatus.PAUSED,
    });
    expect(referralProgramService.update).toHaveBeenCalledWith(dto, "admin-1");
  });

  it("delegates history pagination to the service", async () => {
    const query = { page: 2, pageSize: 10 };
    referralProgramService.history.mockResolvedValue({ data: [], pagination: query });

    await expect(controller.history(query)).resolves.toEqual({
      data: [],
      pagination: query,
    });
    expect(referralProgramService.history).toHaveBeenCalledWith(query);
  });
});
