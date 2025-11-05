import { type HealthCheckResult } from "@nestjs/terminus";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("HealthController", () => {
  let controller: HealthController;
  let healthService: HealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            checkHealth: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthService = module.get<HealthService>(HealthService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("should have health service injected", () => {
    expect(healthService).toBeDefined();
  });

  it("should call health service checkHealth method", async () => {
    const mockResult = {
      status: "ok",
      info: { database: { status: "up" }, redis: { status: "up" } },
      error: {},
      details: { database: { status: "up" }, redis: { status: "up" } },
    } satisfies HealthCheckResult;
    vi.mocked(healthService.checkHealth).mockResolvedValue(mockResult);

    const result = await controller.checkHealth();

    expect(healthService.checkHealth).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockResult);
  });
});
